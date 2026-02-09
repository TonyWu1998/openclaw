import type {
  ClaimedJob,
  DailyRecommendationsResponse,
  GenerateDailyRecommendationsRequest,
  GenerateWeeklyRecommendationsRequest,
  InventoryEvent,
  InventorySnapshotResponse,
  InventoryLot,
  JobResultRequest,
  ManualInventoryEntryRequest,
  ManualInventoryEntryResponse,
  RecommendationFeedbackRecord,
  RecommendationFeedbackRequest,
  RecommendationRun,
  RecommendationRunType,
  ReceiptDetailsResponse,
  ReceiptItem,
  ReceiptProcessJob,
  ReceiptProcessRequest,
  ReceiptReviewRequest,
  ReceiptReviewResponse,
  ReceiptUploadRequest,
  ReceiptUploadResponse,
  WeeklyRecommendationsResponse,
} from "@openclaw/home-inventory-contracts";
import { randomUUID } from "node:crypto";
import type { ReceiptJobStore } from "../types/job-store.js";
import {
  createRecommendationPlannerFromEnv,
  type RecommendationPlanner,
} from "../domain/recommendation-planner.js";

type InMemoryJobStoreOptions = {
  uploadOrigin?: string;
  recommendationPlanner?: RecommendationPlanner;
  maxJobAttempts?: number;
};

export type DeadLetterRecord = {
  jobId: string;
  receiptUploadId: string;
  householdId: string;
  attempts: number;
  error: string;
  failedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  private readonly dailyRecommendations = new Map<string, DailyRecommendationsResponse>();
  private readonly weeklyRecommendations = new Map<string, WeeklyRecommendationsResponse>();
  private readonly feedbackRecords: RecommendationFeedbackRecord[] = [];
  private readonly recommendationIndex = new Map<
    string,
    { householdId: string; itemKeys: string[] }
  >();
  private readonly receiptReviewIdempotency = new Map<string, Set<string>>();
  private readonly manualEntryIdempotency = new Map<string, Set<string>>();
  private readonly deadLetters: DeadLetterRecord[] = [];
  private readonly uploadOrigin: string;
  private readonly recommendationPlanner: RecommendationPlanner;
  private readonly maxJobAttempts: number;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.uploadOrigin = options.uploadOrigin ?? "https://uploads.example.local";
    this.recommendationPlanner =
      options.recommendationPlanner ?? createRecommendationPlannerFromEnv();
    this.maxJobAttempts = Math.max(1, options.maxJobAttempts ?? 3);
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
      receiptImageDataUrl: params.request.receiptImageDataUrl ?? upload.receiptImageDataUrl,
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

  reviewReceipt(
    receiptUploadId: string,
    request: ReceiptReviewRequest,
  ): ReceiptReviewResponse | null {
    const receipt = this.uploads.get(receiptUploadId);
    if (!receipt || receipt.householdId !== request.householdId) {
      return null;
    }

    if (
      request.idempotencyKey &&
      this.hasIdempotencyKey(this.receiptReviewIdempotency, receiptUploadId, request.idempotencyKey)
    ) {
      return {
        receipt: clone(receipt),
        applied: false,
        eventsCreated: 0,
      };
    }

    const currentItems = receipt.items ?? [];
    const reviewedItems =
      request.mode === "append"
        ? mergeReceiptItems([...currentItems, ...request.items])
        : mergeReceiptItems(request.items);

    const eventsCreated = this.applyInventoryItemDelta(
      request.householdId,
      currentItems,
      reviewedItems,
      "receipt_review",
      request.purchasedAt ?? receipt.purchasedAt,
      request.notes,
    );

    const updated: ReceiptDetailsResponse["receipt"] = {
      ...receipt,
      status: "parsed",
      merchantName: request.merchantName ?? receipt.merchantName,
      purchasedAt: request.purchasedAt ?? receipt.purchasedAt,
      items: reviewedItems,
      updatedAt: nowIso(),
    };

    this.uploads.set(receiptUploadId, updated);
    if (request.idempotencyKey) {
      this.registerIdempotencyKey(
        this.receiptReviewIdempotency,
        receiptUploadId,
        request.idempotencyKey,
      );
    }

    const hasItemChanges =
      computeQuantityFingerprint(currentItems) !== computeQuantityFingerprint(reviewedItems);
    const hasMetadataChanges =
      request.merchantName !== undefined ||
      request.purchasedAt !== undefined ||
      request.notes !== undefined;

    return {
      receipt: clone(updated),
      applied: hasItemChanges || hasMetadataChanges || eventsCreated > 0,
      eventsCreated,
    };
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

    // Idempotency guard: retries after a successful submit should not duplicate lot quantities/events.
    if (job.status === "completed") {
      return {
        job: clone(job),
        receipt: clone(upload),
      };
    }

    if (job.status !== "processing" && job.status !== "queued") {
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

    const now = nowIso();
    if (job.attempts < this.maxJobAttempts) {
      const retried: ReceiptProcessJob = {
        ...job,
        status: "queued",
        error,
        updatedAt: now,
      };

      this.jobs.set(jobId, retried);
      this.queue.push(jobId);

      return clone(retried);
    }

    const failed: ReceiptProcessJob = {
      ...job,
      status: "failed",
      error,
      updatedAt: now,
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
    this.deadLetters.push({
      jobId: failed.jobId,
      receiptUploadId: failed.receiptUploadId,
      householdId: failed.householdId,
      attempts: failed.attempts,
      error,
      failedAt: failed.updatedAt,
    });

    return clone(failed);
  }

  getInventory(householdId: string): InventorySnapshotResponse {
    const lots = clone(this.inventoryLots.get(householdId) ?? []).toSorted((a, b) =>
      a.itemKey.localeCompare(b.itemKey),
    );
    const events = clone(this.inventoryEvents.get(householdId) ?? []).toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    return {
      householdId,
      lots,
      events,
    };
  }

  addManualItems(
    householdId: string,
    request: ManualInventoryEntryRequest,
  ): ManualInventoryEntryResponse {
    if (
      request.idempotencyKey &&
      this.hasIdempotencyKey(this.manualEntryIdempotency, householdId, request.idempotencyKey)
    ) {
      return {
        householdId,
        inventory: this.getInventory(householdId),
        applied: false,
        eventsCreated: 0,
      };
    }

    const items = mergeReceiptItems(request.items);
    const eventsCreated = this.applyInventoryMutations(
      householdId,
      items,
      request.purchasedAt,
      "manual",
      request.notes ? `manual entry: ${request.notes}` : "manual entry",
    );

    if (request.idempotencyKey) {
      this.registerIdempotencyKey(this.manualEntryIdempotency, householdId, request.idempotencyKey);
    }

    return {
      householdId,
      inventory: this.getInventory(householdId),
      applied: eventsCreated > 0,
      eventsCreated,
    };
  }

  async generateDailyRecommendations(
    householdId: string,
    request: GenerateDailyRecommendationsRequest,
  ): Promise<DailyRecommendationsResponse> {
    const targetDate = request.date ?? todayIsoDate();
    const inventory = this.getInventory(householdId);
    const feedbackByItem = this.buildFeedbackByItem(householdId);

    const generated = await this.recommendationPlanner.generateDaily({
      householdId,
      targetDate,
      inventory,
      feedbackByItem,
    });

    const run = this.createRun(householdId, "daily", generated.model, targetDate);

    const response: DailyRecommendationsResponse = {
      run,
      recommendations: generated.recommendations.map((entry) => {
        const recommendationId = `rec_${randomUUID()}`;
        this.recommendationIndex.set(recommendationId, {
          householdId,
          itemKeys: clone(entry.itemKeys),
        });

        return {
          recommendationId,
          householdId,
          mealDate: targetDate,
          title: entry.title,
          cuisine: entry.cuisine,
          rationale: entry.rationale,
          itemKeys: entry.itemKeys,
          score: entry.score,
        };
      }),
    };

    this.dailyRecommendations.set(householdId, clone(response));
    return response;
  }

  getDailyRecommendations(householdId: string): DailyRecommendationsResponse | null {
    const result = this.dailyRecommendations.get(householdId);
    return result ? clone(result) : null;
  }

  async generateWeeklyRecommendations(
    householdId: string,
    request: GenerateWeeklyRecommendationsRequest,
  ): Promise<WeeklyRecommendationsResponse> {
    const weekOf = request.weekOf ?? todayIsoDate();
    const inventory = this.getInventory(householdId);
    const feedbackByItem = this.buildFeedbackByItem(householdId);

    const generated = await this.recommendationPlanner.generateWeekly({
      householdId,
      targetDate: weekOf,
      inventory,
      feedbackByItem,
    });

    const run = this.createRun(householdId, "weekly", generated.model, weekOf);

    const response: WeeklyRecommendationsResponse = {
      run,
      recommendations: generated.recommendations.map((entry) => {
        const recommendationId = `rec_${randomUUID()}`;
        this.recommendationIndex.set(recommendationId, {
          householdId,
          itemKeys: [entry.itemKey],
        });

        return {
          recommendationId,
          householdId,
          weekOf,
          itemKey: entry.itemKey,
          itemName: entry.itemName,
          quantity: entry.quantity,
          unit: entry.unit,
          priority: entry.priority,
          rationale: entry.rationale,
          score: entry.score,
        };
      }),
    };

    this.weeklyRecommendations.set(householdId, clone(response));
    return response;
  }

  getWeeklyRecommendations(householdId: string): WeeklyRecommendationsResponse | null {
    const result = this.weeklyRecommendations.get(householdId);
    return result ? clone(result) : null;
  }

  listDeadLetters(): DeadLetterRecord[] {
    return clone(this.deadLetters).toSorted((a, b) => b.failedAt.localeCompare(a.failedAt));
  }

  recordRecommendationFeedback(
    recommendationId: string,
    request: RecommendationFeedbackRequest,
  ): RecommendationFeedbackRecord | null {
    const recommendation = this.recommendationIndex.get(recommendationId);
    if (!recommendation || recommendation.householdId !== request.householdId) {
      return null;
    }

    const feedback: RecommendationFeedbackRecord = {
      feedbackId: `feedback_${randomUUID()}`,
      recommendationId,
      householdId: request.householdId,
      signalType: request.signalType,
      signalValue: request.signalValue ?? defaultSignalValue(request.signalType),
      context: request.context,
      createdAt: nowIso(),
    };

    this.feedbackRecords.push(feedback);
    return clone(feedback);
  }

  private createRun(
    householdId: string,
    runType: RecommendationRunType,
    model: string,
    targetDate: string,
  ): RecommendationRun {
    return {
      runId: `run_${randomUUID()}`,
      householdId,
      runType,
      model,
      createdAt: nowIso(),
      targetDate,
    };
  }

  private buildFeedbackByItem(householdId: string): Record<string, number> {
    const sums = new Map<string, number>();
    const counts = new Map<string, number>();

    for (const feedback of this.feedbackRecords) {
      if (feedback.householdId !== householdId) {
        continue;
      }

      const indexed = this.recommendationIndex.get(feedback.recommendationId);
      if (!indexed) {
        continue;
      }

      const value = feedback.signalValue;
      for (const itemKey of indexed.itemKeys) {
        sums.set(itemKey, (sums.get(itemKey) ?? 0) + value);
        counts.set(itemKey, (counts.get(itemKey) ?? 0) + 1);
      }
    }

    const result: Record<string, number> = {};
    for (const [itemKey, sum] of sums) {
      const count = counts.get(itemKey) ?? 1;
      result[itemKey] = Number.parseFloat((sum / count).toFixed(3));
    }

    return result;
  }

  private applyInventoryMutations(
    householdId: string,
    items: ReceiptItem[],
    purchasedAt?: string,
    source = "receipt",
    reasonPrefix = "receipt item",
  ): number {
    const lots = this.inventoryLots.get(householdId) ?? [];
    const events = this.inventoryEvents.get(householdId) ?? [];
    const eventsCreated = this.applyInventoryAddsToCollections(
      householdId,
      lots,
      events,
      items,
      purchasedAt,
      source,
      reasonPrefix,
    );

    this.inventoryLots.set(householdId, lots);
    this.inventoryEvents.set(householdId, events);
    return eventsCreated;
  }

  private applyInventoryItemDelta(
    householdId: string,
    previousItems: ReceiptItem[],
    nextItems: ReceiptItem[],
    source: string,
    purchasedAt?: string,
    reason?: string,
  ): number {
    const previous = aggregateItems(previousItems);
    const next = aggregateItems(nextItems);
    const itemKeys = new Set([...previous.keys(), ...next.keys()]);
    const lots = this.inventoryLots.get(householdId) ?? [];
    const events = this.inventoryEvents.get(householdId) ?? [];
    let eventsCreated = 0;

    for (const key of itemKeys) {
      const prev = previous.get(key);
      const nxt = next.get(key);
      const prevQuantity = prev?.quantity ?? 0;
      const nextQuantity = nxt?.quantity ?? 0;
      const delta = Number.parseFloat((nextQuantity - prevQuantity).toFixed(3));
      if (delta === 0) {
        continue;
      }

      if (delta > 0) {
        eventsCreated += this.applyInventoryAddsToCollections(
          householdId,
          lots,
          events,
          [
            {
              ...(nxt?.item ?? prev?.item ?? inferFallbackItemFromKey(key)),
              quantity: delta,
            },
          ],
          purchasedAt,
          source,
          reason ?? "receipt review delta",
        );
        continue;
      }

      const target = nxt?.item ?? prev?.item ?? inferFallbackItemFromKey(key);
      const now = nowIso();
      let remainingToReduce = Math.abs(delta);
      const candidates = lots.filter(
        (lot) =>
          lot.itemKey === target.itemKey &&
          lot.unit === target.unit &&
          lot.category === target.category,
      );

      for (const lot of candidates) {
        if (remainingToReduce <= 0) {
          break;
        }
        if (lot.quantityRemaining <= 0) {
          continue;
        }

        const reduced = Number.parseFloat(
          Math.min(lot.quantityRemaining, remainingToReduce).toFixed(3),
        );
        if (reduced <= 0) {
          continue;
        }

        lot.quantityRemaining = Number.parseFloat((lot.quantityRemaining - reduced).toFixed(3));
        lot.updatedAt = now;
        remainingToReduce = Number.parseFloat((remainingToReduce - reduced).toFixed(3));

        events.push({
          eventId: `event_${randomUUID()}`,
          householdId,
          lotId: lot.lotId,
          eventType: "adjust",
          quantity: reduced,
          unit: target.unit,
          source,
          reason: reason ?? `receipt review correction: ${target.rawName}`,
          createdAt: now,
        });
        eventsCreated += 1;
      }
    }

    this.inventoryLots.set(
      householdId,
      lots.filter((lot) => lot.quantityRemaining > 0),
    );
    this.inventoryEvents.set(householdId, events);
    return eventsCreated;
  }

  private applyInventoryAddsToCollections(
    householdId: string,
    lots: InventoryLot[],
    events: InventoryEvent[],
    items: ReceiptItem[],
    purchasedAt: string | undefined,
    source: string,
    reasonPrefix: string,
  ): number {
    let eventsCreated = 0;

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
        source,
        reason: `${reasonPrefix}: ${item.rawName}`,
        createdAt: now,
      });
      eventsCreated += 1;
    }

    return eventsCreated;
  }

  private hasIdempotencyKey(store: Map<string, Set<string>>, scope: string, key: string): boolean {
    return store.get(scope)?.has(key) ?? false;
  }

  private registerIdempotencyKey(
    store: Map<string, Set<string>>,
    scope: string,
    key: string,
  ): void {
    const keys = store.get(scope) ?? new Set<string>();
    keys.add(key);
    store.set(scope, keys);
  }
}

type AggregatedItem = {
  item: ReceiptItem;
  quantity: number;
};

function aggregateItems(items: ReceiptItem[]): Map<string, AggregatedItem> {
  const map = new Map<string, AggregatedItem>();

  for (const item of items) {
    const key = itemAggregateKey(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        item: clone(item),
        quantity: item.quantity,
      });
      continue;
    }

    existing.quantity = Number.parseFloat((existing.quantity + item.quantity).toFixed(3));
  }

  return map;
}

function mergeReceiptItems(items: ReceiptItem[]): ReceiptItem[] {
  return [...aggregateItems(items).values()].map((entry) => ({
    ...entry.item,
    quantity: entry.quantity,
  }));
}

function itemAggregateKey(item: ReceiptItem): string {
  return `${item.itemKey}:${item.unit}:${item.category}`;
}

function computeQuantityFingerprint(items: ReceiptItem[]): string {
  return JSON.stringify(
    [...aggregateItems(items).entries()]
      .map(([key, value]) => ({ key, quantity: value.quantity }))
      .toSorted((a, b) => a.key.localeCompare(b.key)),
  );
}

function inferFallbackItemFromKey(key: string): ReceiptItem {
  const [itemKey] = key.split(":");
  return {
    itemKey: itemKey || "unknown-item",
    rawName: itemKey || "unknown-item",
    normalizedName: itemKey || "unknown-item",
    quantity: 0,
    unit: "count",
    category: "other",
    confidence: 0.5,
  };
}

function defaultSignalValue(signalType: RecommendationFeedbackRequest["signalType"]): number {
  switch (signalType) {
    case "accepted":
      return 1;
    case "consumed":
      return 0.75;
    case "edited":
      return 0.25;
    case "ignored":
      return -0.25;
    case "rejected":
      return -0.75;
    case "wasted":
      return -1;
    default:
      return 0;
  }
}
