import { randomUUID } from "node:crypto";
import type { ReceiptProcessJob, ReceiptUploadRequest, ReceiptUploadResponse } from "@openclaw/home-inventory-contracts";
import type { ReceiptJobStore } from "../types/job-store.js";

type InMemoryJobStoreOptions = {
  uploadOrigin?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryJobStore implements ReceiptJobStore {
  private readonly uploads = new Map<string, { householdId: string; filename: string; contentType: string; path: string }>();
  private readonly jobs = new Map<string, ReceiptProcessJob>();
  private readonly queue: string[] = [];
  private readonly uploadOrigin: string;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.uploadOrigin = options.uploadOrigin ?? "https://uploads.example.local";
  }

  createUpload(request: ReceiptUploadRequest): ReceiptUploadResponse {
    const receiptUploadId = `receipt_${randomUUID()}`;
    const sanitizedFilename = request.filename.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `receipts/${request.householdId}/${receiptUploadId}/${sanitizedFilename}`;

    this.uploads.set(receiptUploadId, {
      householdId: request.householdId,
      filename: request.filename,
      contentType: request.contentType,
      path,
    });

    return {
      receiptUploadId,
      uploadUrl: `${this.uploadOrigin}/upload/${receiptUploadId}`,
      path,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  enqueueJob(params: { householdId: string; receiptUploadId: string }): ReceiptProcessJob {
    const upload = this.uploads.get(params.receiptUploadId);
    if (!upload) {
      throw new Error(`receipt upload not found: ${params.receiptUploadId}`);
    }

    if (upload.householdId !== params.householdId) {
      throw new Error(
        `receipt upload household mismatch: upload=${upload.householdId} request=${params.householdId}`,
      );
    }

    const jobId = `job_${randomUUID()}`;
    const now = nowIso();

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
    return job;
  }

  getJob(jobId: string): ReceiptProcessJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  claimNextJob(): ReceiptProcessJob | null {
    while (this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) {
        continue;
      }
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") {
        continue;
      }
      const claimed: ReceiptProcessJob = {
        ...job,
        status: "processing",
        attempts: job.attempts + 1,
        updatedAt: nowIso(),
      };
      this.jobs.set(jobId, claimed);
      return claimed;
    }
    return null;
  }

  completeJob(jobId: string): ReceiptProcessJob | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    const completed: ReceiptProcessJob = {
      ...job,
      status: "completed",
      error: undefined,
      updatedAt: nowIso(),
    };
    this.jobs.set(jobId, completed);
    return completed;
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
    this.jobs.set(jobId, failed);
    return failed;
  }
}
