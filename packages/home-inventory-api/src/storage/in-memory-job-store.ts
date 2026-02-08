import { randomUUID } from "node:crypto";
import type {
  ClaimedJob,
  InventoryEvent,
  InventorySnapshotResponse,
  InventoryLot,
  JobResultRequest,
  ReceiptDetailsResponse,
  ReceiptItem,
  ReceiptProcessJob,
  ReceiptProcessRequest,
  ReceiptUploadRequest,
  ReceiptUploadResponse,
} from "@openclaw/home-inventory-contracts";
import type { ReceiptJobStore } from "../types/job-store.js";

type InMemoryJobStoreOptions = {
  uploadOrigin?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryJobStore implements ReceiptJobStore {
  private readonly uploads = new Map<string, ReceiptDetailsResponse["receipt"]>();
  private readonly jobs = new Map<string, ReceiptProcessJob>();
  private readonly queue: string[] = [];
  private readonly inventoryLots = new Map<string, InventoryLot[]>();
  private readonly inventoryEvents = new Map<string, InventoryEvent[]>();
  private readonly uploadOrigin: string;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.uploadOrigin = options.uploadOrigin ?? "https://uploads.example.local";
  }

  createUpload(request: ReceiptUploadRequest): ReceiptUploadResponse {
    const receiptUploadId = `receipt_${randomUUID()}`;
    const sanitizedFilename = request.filename.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `receipts/${request.householdId}/${receiptUploadId}/${sanitizedFilename}`;
    const now = nowIso();

    this.uploads.set(receiptUploadId, {
      receiptUploadId,
      householdId: request.householdId,
      filename: request.filename,
      contentType: request.contentType,
      path,
      status: "uploaded",
      createdAt: now,
      updatedAt: now,
    });

    return {
      receiptUploadId,
      uploadUrl: `${this.uploadOrigin}/upload/${receiptUploadId}`,
      path,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  enqueueJob(params: {
    householdId: string;
    receiptUploadId: string;
    request: ReceiptProcessRequest;
  }): ReceiptProcessJob {
    const upload = this.uploads.get(params.receiptUploadId);
    if (!upload) {
      throw new Error(`receipt upload not found: ${params.receiptUploadId}`);
    }

    if (upload.householdId !== params.householdId) {
      throw new Error(
        `receipt upload household mismatch: upload=${upload.householdId} request=${params.householdId}`,
      );
    }

    const now = nowIso();
    this.uploads.set(params.receiptUploadId, {
      ...upload,
      status: "processing",
      ocrText: params.request.ocrText ?? upload.ocrText,
      merchantName: params.request.merchantName ?? upload.merchantName,
      purchasedAt: params.request.purchasedAt ?? upload.purchasedAt,
      updatedAt: now,
    });

    const jobId = `job_${randomUUID()}`;

    const job: ReceiptProcessJob = {
      jobId,
      receiptUploadId: params.receiptUploadId,
      householdId: params.householdId,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    return clone(job);
  }

  getJob(jobId: string): ReceiptProcessJob | null {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  getReceipt(receiptUploadId: string): ReceiptDetailsResponse | null {
    const receipt = this.uploads.get(receiptUploadId);
    if (!receipt) {
      return null;
    }
    return { receipt: clone(receipt) };
  }

  claimNextJob(): ClaimedJob | null {
    while (this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) {
        continue;
      }

      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") {
        continue;
      }

      const receipt = this.uploads.get(job.receiptUploadId);
      if (!receipt) {
        continue;
      }

      const claimedJob: ReceiptProcessJob = {
        ...job,
        status: "processing",
        attempts: job.attempts + 1,
        updatedAt: nowIso(),
      };

      this.jobs.set(jobId, claimedJob);
      this.uploads.set(job.receiptUploadId, {
        ...receipt,
        status: "processing",
        updatedAt: claimedJob.updatedAt,
      });

      return {
        job: clone(claimedJob),
        receipt: clone(this.uploads.get(job.receiptUploadId)!),
      };
    }

    return null;
  }

  submitJobResult(
    jobId: string,
    result: JobResultRequest,
  ): { job: ReceiptProcessJob; receipt: ReceiptDetailsResponse["receipt"] } | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const upload = this.uploads.get(job.receiptUploadId);
    if (!upload) {
      return null;
    }

    const now = nowIso();

    const receipt: ReceiptDetailsResponse["receipt"] = {
      ...upload,
      status: "parsed",
      merchantName: result.merchantName ?? upload.merchantName,
      purchasedAt: result.purchasedAt ?? upload.purchasedAt,
      ocrText: result.ocrText ?? upload.ocrText,
      items: clone(result.items),
      updatedAt: now,
    };

    const completedJob: ReceiptProcessJob = {
      ...job,
      status: "completed",
      notes: result.notes,
      error: undefined,
      updatedAt: now,
    };

    this.uploads.set(receipt.receiptUploadId, receipt);
    this.jobs.set(jobId, completedJob);
    this.applyInventoryMutations(receipt.householdId, receipt.items ?? [], receipt.purchasedAt);

    return {
      job: clone(completedJob),
      receipt: clone(receipt),
    };
  }

  completeJob(jobId: string, notes?: string): ReceiptProcessJob | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    const completed: ReceiptProcessJob = {
      ...job,
      status: "completed",
      error: undefined,
      notes,
      updatedAt: nowIso(),
    };
    this.jobs.set(jobId, completed);
    return clone(completed);
  }

  failJob(jobId: string, error: string): ReceiptProcessJob | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const failed: ReceiptProcessJob = {
      ...job,
      status: "failed",
      error,
      updatedAt: nowIso(),
    };

    const upload = this.uploads.get(job.receiptUploadId);
    if (upload) {
      this.uploads.set(job.receiptUploadId, {
        ...upload,
        status: "failed",
        updatedAt: failed.updatedAt,
      });
    }

    this.jobs.set(jobId, failed);
    return clone(failed);
  }

  getInventory(householdId: string): InventorySnapshotResponse {
    const lots = clone(this.inventoryLots.get(householdId) ?? []).sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    const events = clone(this.inventoryEvents.get(householdId) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      householdId,
      lots,
      events,
    };
  }

  private applyInventoryMutations(householdId: string, items: ReceiptItem[], purchasedAt?: string): void {
    const lots = this.inventoryLots.get(householdId) ?? [];
    const events = this.inventoryEvents.get(householdId) ?? [];

    for (const item of items) {
      const now = nowIso();
      let lot = lots.find(
        (candidate) =>
          candidate.itemKey === item.itemKey &&
          candidate.unit === item.unit &&
          candidate.category === item.category,
      );

      if (!lot) {
        lot = {
          lotId: `lot_${randomUUID()}`,
          householdId,
          itemKey: item.itemKey,
          itemName: item.normalizedName,
          quantityRemaining: 0,
          unit: item.unit,
          category: item.category,
          purchasedAt,
          updatedAt: now,
        };
        lots.push(lot);
      }

      lot.quantityRemaining += item.quantity;
      lot.itemName = item.normalizedName;
      lot.updatedAt = now;
      if (purchasedAt) {
        lot.purchasedAt = purchasedAt;
      }

      events.push({
        eventId: `event_${randomUUID()}`,
        householdId,
        lotId: lot.lotId,
        eventType: "add",
        quantity: item.quantity,
        unit: item.unit,
        source: "receipt",
        reason: `receipt item: ${item.rawName}`,
        createdAt: now,
      });
    }

    this.inventoryLots.set(householdId, lots);
    this.inventoryEvents.set(householdId, events);
  }
}
