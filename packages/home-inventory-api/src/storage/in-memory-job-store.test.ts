import type { ReceiptItem } from "@openclaw/home-inventory-contracts";
import { describe, expect, it, vi } from "vitest";
import type { RecommendationPlanner } from "../domain/recommendation-planner.js";
import { InMemoryJobStore } from "./in-memory-job-store.js";

const SEED_ITEMS: ReceiptItem[] = [
  {
    itemKey: "jasmine-rice",
    rawName: "Jasmine Rice 2kg",
    normalizedName: "jasmine rice",
    quantity: 2,
    unit: "kg",
    category: "grain",
    confidence: 0.95,
  },
  {
    itemKey: "tomato",
    rawName: "Tomato",
    normalizedName: "tomato",
    quantity: 4,
    unit: "count",
    category: "produce",
    confidence: 0.91,
  },
];

function seedInventory(store: InMemoryJobStore, householdId: string): void {
  const upload = store.createUpload({
    householdId,
    filename: "seed-receipt.jpg",
    contentType: "image/jpeg",
  });

  const job = store.enqueueJob({
    householdId,
    receiptUploadId: upload.receiptUploadId,
    request: {
      householdId,
      ocrText: "Jasmine Rice 2kg\\nTomato x4",
    },
  });

  store.submitJobResult(job.jobId, {
    merchantName: "Seed Market",
    purchasedAt: "2026-02-08T12:00:00.000Z",
    ocrText: "Jasmine Rice 2kg\\nTomato x4",
    items: SEED_ITEMS,
    notes: "seed inventory",
  });
}

describe("InMemoryJobStore recommendation loop", () => {
  it("feeds recorded recommendation feedback back into planner inputs", async () => {
    const generateDailyMock = vi.fn(async () => ({
      model: "planner/mock-v1",
      recommendations: [
        {
          title: "Rice and tomato stir fry",
          cuisine: "chinese",
          rationale: "Uses current stock first.",
          itemKeys: ["jasmine-rice", "tomato"],
          score: 0.82,
        },
      ],
    }));

    const generateWeeklyMock = vi.fn(async () => ({
      model: "planner/mock-v1",
      recommendations: [
        {
          itemKey: "jasmine-rice",
          itemName: "Jasmine Rice",
          quantity: 1,
          unit: "kg" as const,
          priority: "high" as const,
          rationale: "Stock should be replenished this week.",
          score: 0.77,
        },
      ],
    }));

    const planner: RecommendationPlanner = {
      generateDaily: generateDailyMock,
      generateWeekly: generateWeeklyMock,
    };

    const householdId = "household_main";
    const store = new InMemoryJobStore({ recommendationPlanner: planner });
    seedInventory(store, householdId);

    const daily = await store.generateDailyRecommendations(householdId, { date: "2026-02-09" });
    expect(generateDailyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId,
        feedbackByItem: {},
      }),
    );

    const recommendationId = daily.recommendations[0]?.recommendationId;
    expect(recommendationId).toBeDefined();

    if (!recommendationId) {
      throw new Error("expected daily recommendation id");
    }

    const feedback = store.recordRecommendationFeedback(recommendationId, {
      householdId,
      signalType: "accepted",
    });

    expect(feedback?.signalValue).toBe(1);

    await store.generateWeeklyRecommendations(householdId, { weekOf: "2026-02-09" });
    expect(generateWeeklyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId,
        feedbackByItem: {
          "jasmine-rice": 1,
          tomato: 1,
        },
      }),
    );
  });

  it("rejects feedback when household does not own the recommendation", async () => {
    const planner: RecommendationPlanner = {
      generateDaily: async () => ({
        model: "planner/mock-v1",
        recommendations: [
          {
            title: "Tomato rice bowl",
            cuisine: "chinese",
            rationale: "Uses what is already in stock.",
            itemKeys: ["jasmine-rice"],
            score: 0.75,
          },
        ],
      }),
      generateWeekly: async () => ({ model: "planner/mock-v1", recommendations: [] }),
    };

    const store = new InMemoryJobStore({ recommendationPlanner: planner });
    seedInventory(store, "household_a");

    const daily = await store.generateDailyRecommendations("household_a", { date: "2026-02-09" });
    const recommendationId = daily.recommendations[0]?.recommendationId;
    expect(recommendationId).toBeDefined();

    if (!recommendationId) {
      throw new Error("expected daily recommendation id");
    }

    const feedback = store.recordRecommendationFeedback(recommendationId, {
      householdId: "household_b",
      signalType: "accepted",
    });

    expect(feedback).toBeNull();
  });
});

describe("InMemoryJobStore reliability", () => {
  it("requeues failures until max attempts then dead-letters the job", () => {
    const store = new InMemoryJobStore({ maxJobAttempts: 2 });
    const householdId = "household_retry";

    const upload = store.createUpload({
      householdId,
      filename: "retry.jpg",
      contentType: "image/jpeg",
    });

    const enqueued = store.enqueueJob({
      householdId,
      receiptUploadId: upload.receiptUploadId,
      request: { householdId, ocrText: "Milk 1L" },
    });

    const claimOne = store.claimNextJob();
    expect(claimOne?.job.jobId).toBe(enqueued.jobId);
    expect(claimOne?.job.attempts).toBe(1);

    const retryState = store.failJob(enqueued.jobId, "temporary extraction failure");
    expect(retryState?.status).toBe("queued");
    expect(store.listDeadLetters()).toHaveLength(0);

    const claimTwo = store.claimNextJob();
    expect(claimTwo?.job.jobId).toBe(enqueued.jobId);
    expect(claimTwo?.job.attempts).toBe(2);

    const finalState = store.failJob(enqueued.jobId, "permanent extraction failure");
    expect(finalState?.status).toBe("failed");

    const deadLetters = store.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.jobId).toBe(enqueued.jobId);
    expect(deadLetters[0]?.attempts).toBe(2);
  });

  it("meets a NAS-oriented in-memory soak profile for core inventory mutations", () => {
    const store = new InMemoryJobStore();
    const householdId = "household_soak";
    const startedAt = Date.now();

    for (let index = 0; index < 400; index += 1) {
      const upload = store.createUpload({
        householdId,
        filename: `receipt-${index}.jpg`,
        contentType: "image/jpeg",
      });

      const enqueued = store.enqueueJob({
        householdId,
        receiptUploadId: upload.receiptUploadId,
        request: {
          householdId,
          ocrText: `Rice ${index + 1}`,
        },
      });

      store.submitJobResult(enqueued.jobId, {
        ocrText: `Rice ${index + 1}`,
        items: [
          {
            itemKey: "jasmine-rice",
            rawName: `Jasmine Rice ${index + 1}kg`,
            normalizedName: "jasmine rice",
            quantity: 1,
            unit: "kg",
            category: "grain",
            confidence: 0.9,
          },
        ],
      });
    }

    const snapshot = store.getInventory(householdId);
    const elapsedMs = Date.now() - startedAt;

    expect(snapshot.lots.length).toBeGreaterThan(0);
    expect(snapshot.events.length).toBe(400);
    expect(elapsedMs).toBeLessThan(4000);
  });
});

describe("InMemoryJobStore phase5d batch receipt enqueue", () => {
  it("processes per-receipt validation and returns partial failures", () => {
    const store = new InMemoryJobStore();
    const upload = store.createUpload({
      householdId: "household_batch",
      filename: "batch-1.jpg",
      contentType: "image/jpeg",
    });

    const response = store.enqueueBatchJobs({
      receipts: [
        {
          receiptUploadId: upload.receiptUploadId,
          householdId: "household_batch",
          ocrText: "Rice 2kg",
        },
        {
          receiptUploadId: "receipt_missing",
          householdId: "household_batch",
          ocrText: "Tomato x2",
        },
        {
          receiptUploadId: upload.receiptUploadId,
          householdId: "household_batch",
        },
      ],
    });

    expect(response.requested).toBe(3);
    expect(response.accepted).toBe(1);
    expect(response.rejected).toBe(2);
    expect(response.results.filter((result) => result.accepted)).toHaveLength(1);
    expect(
      response.results.some((result) => !result.accepted && result.error?.includes("not found")),
    ).toBe(true);
    expect(
      response.results.some(
        (result) =>
          !result.accepted && result.error === "ocrText or receiptImageDataUrl is required",
      ),
    ).toBe(true);
  });

  it("keeps batch enqueue idempotent for retrying the same receipt entry", () => {
    const store = new InMemoryJobStore();
    const upload = store.createUpload({
      householdId: "household_batch_idempotent",
      filename: "batch-idempotent.jpg",
      contentType: "image/jpeg",
    });

    const first = store.enqueueBatchJobs({
      receipts: [
        {
          receiptUploadId: upload.receiptUploadId,
          householdId: "household_batch_idempotent",
          ocrText: "Egg x12",
          idempotencyKey: "batch-key-1",
        },
      ],
    });
    const second = store.enqueueBatchJobs({
      receipts: [
        {
          receiptUploadId: upload.receiptUploadId,
          householdId: "household_batch_idempotent",
          ocrText: "Egg x12",
          idempotencyKey: "batch-key-1",
        },
      ],
    });

    const firstJobId = first.results[0]?.job?.jobId;
    const secondJobId = second.results[0]?.job?.jobId;
    expect(firstJobId).toBeDefined();
    expect(secondJobId).toBe(firstJobId);

    const claimOne = store.claimNextJob();
    expect(claimOne?.job.jobId).toBe(firstJobId);

    const claimTwo = store.claimNextJob();
    expect(claimTwo).toBeNull();
  });
});

describe("InMemoryJobStore phase5a mutations", () => {
  it("applies receipt review deltas and writes receipt_review events", () => {
    const householdId = "household_review";
    const store = new InMemoryJobStore();
    seedInventory(store, householdId);

    const upload = store.createUpload({
      householdId,
      filename: "review-source.jpg",
      contentType: "image/jpeg",
    });
    const job = store.enqueueJob({
      householdId,
      receiptUploadId: upload.receiptUploadId,
      request: { householdId, ocrText: "Tomato x2" },
    });
    store.submitJobResult(job.jobId, {
      items: [
        {
          itemKey: "tomato",
          rawName: "Tomato",
          normalizedName: "tomato",
          quantity: 2,
          unit: "count",
          category: "produce",
          confidence: 0.8,
        },
      ],
    });

    const reviewed = store.reviewReceipt(upload.receiptUploadId, {
      householdId,
      mode: "overwrite",
      items: [
        {
          itemKey: "tomato",
          rawName: "Tomato",
          normalizedName: "tomato",
          quantity: 1,
          unit: "count",
          category: "produce",
          confidence: 0.9,
        },
      ],
      idempotencyKey: "review-1",
    });

    expect(reviewed?.applied).toBe(true);
    expect(reviewed?.eventsCreated).toBe(1);

    const snapshot = store.getInventory(householdId);
    expect(snapshot.events.some((event) => event.source === "receipt_review")).toBe(true);
    const tomatoLot = snapshot.lots.find((lot) => lot.itemKey === "tomato");
    expect(tomatoLot?.quantityRemaining).toBe(5);
  });

  it("keeps manual entry idempotent with repeated idempotency key", () => {
    const householdId = "household_manual";
    const store = new InMemoryJobStore();

    const first = store.addManualItems(householdId, {
      idempotencyKey: "manual-1",
      items: [
        {
          itemKey: "trash-bag",
          rawName: "Trash Bag",
          normalizedName: "trash bag",
          quantity: 1,
          unit: "box",
          category: "household",
          confidence: 1,
        },
      ],
    });
    expect(first.applied).toBe(true);
    expect(first.eventsCreated).toBe(1);

    const second = store.addManualItems(householdId, {
      idempotencyKey: "manual-1",
      items: [
        {
          itemKey: "trash-bag",
          rawName: "Trash Bag",
          normalizedName: "trash bag",
          quantity: 1,
          unit: "box",
          category: "household",
          confidence: 1,
        },
      ],
    });
    expect(second.applied).toBe(false);
    expect(second.eventsCreated).toBe(0);
    expect(second.inventory.events.filter((event) => event.source === "manual")).toHaveLength(1);
  });
});

describe("InMemoryJobStore phase5b expiry intelligence", () => {
  it("applies estimated expiry metadata for newly added lots", () => {
    const store = new InMemoryJobStore();
    seedInventory(store, "household_expiry");

    const snapshot = store.getInventory("household_expiry");
    const proteinLot = snapshot.lots.find((lot) => lot.itemKey === "tomato");
    expect(proteinLot?.expirySource).toBe("estimated");
    expect(proteinLot?.expiryEstimatedAt).toBeDefined();
    expect(proteinLot?.expiresAt).toBeDefined();
  });

  it("overrides lot expiry with exact source and returns risk entries", () => {
    const householdId = "household_expiry_override";
    const store = new InMemoryJobStore();
    seedInventory(store, householdId);

    const snapshot = store.getInventory(householdId);
    const lot = snapshot.lots.find((entry) => entry.itemKey === "jasmine-rice");
    expect(lot).toBeDefined();
    if (!lot) {
      throw new Error("expected seeded lot");
    }

    const overridden = store.overrideLotExpiry(householdId, lot.lotId, {
      householdId,
      expiresAt: "2026-02-10T00:00:00.000Z",
    });

    expect(overridden?.lot.expirySource).toBe("exact");
    expect(overridden?.lot.expiryConfidence).toBe(1);

    const risk = store.getExpiryRisk(householdId);
    expect(risk.items.length).toBeGreaterThan(0);
    expect(risk.items.every((entry) => entry.riskLevel.length > 0)).toBe(true);
  });
});

describe("InMemoryJobStore phase5c meal checkins", () => {
  it("creates pending checkins and applies FEFO depletion when quantities are provided", async () => {
    const householdId = "household_checkin_fefo";
    const planner: RecommendationPlanner = {
      generateDaily: async () => ({
        model: "planner/mock-v1",
        recommendations: [
          {
            title: "Tomato soup",
            cuisine: "mixed",
            rationale: "Use tomato first.",
            itemKeys: ["tomato"],
            score: 0.8,
          },
        ],
      }),
      generateWeekly: async () => ({ model: "planner/mock-v1", recommendations: [] }),
    };

    const store = new InMemoryJobStore({ recommendationPlanner: planner });
    store.addManualItems(householdId, {
      items: [
        {
          itemKey: "tomato",
          rawName: "Tomato",
          normalizedName: "tomato",
          quantity: 2,
          unit: "count",
          category: "produce",
          confidence: 1,
        },
      ],
      purchasedAt: "2026-02-01T00:00:00.000Z",
    });
    store.addManualItems(householdId, {
      items: [
        {
          itemKey: "tomato",
          rawName: "Tomato",
          normalizedName: "tomato",
          quantity: 2,
          unit: "count",
          category: "produce",
          confidence: 1,
        },
      ],
      purchasedAt: "2026-02-05T00:00:00.000Z",
    });

    const seeded = store.getInventory(householdId);
    const lots = seeded.lots.filter((lot) => lot.itemKey === "tomato");
    expect(lots).toHaveLength(2);
    const oldestLot = lots.find((lot) => lot.purchasedAt === "2026-02-01T00:00:00.000Z");
    const newestLot = lots.find((lot) => lot.purchasedAt === "2026-02-05T00:00:00.000Z");
    expect(oldestLot).toBeDefined();
    expect(newestLot).toBeDefined();
    if (!oldestLot || !newestLot) {
      throw new Error("expected seeded tomato lots");
    }

    store.overrideLotExpiry(householdId, oldestLot.lotId, {
      householdId,
      expiresAt: "2026-02-10T00:00:00.000Z",
    });
    store.overrideLotExpiry(householdId, newestLot.lotId, {
      householdId,
      expiresAt: "2026-02-20T00:00:00.000Z",
    });

    await store.generateDailyRecommendations(householdId, { date: "2026-02-09" });
    const pending = store.listPendingCheckins(householdId);
    const checkinId = pending.checkins[0]?.checkinId;
    expect(checkinId).toBeDefined();
    if (!checkinId) {
      throw new Error("expected pending checkin");
    }

    const submitted = store.submitMealCheckin(checkinId, {
      householdId,
      outcome: "made",
      lines: [
        {
          itemKey: "tomato",
          unit: "count",
          quantityConsumed: 3,
        },
      ],
    });

    expect(submitted?.checkin.status).toBe("completed");
    expect(submitted?.eventsCreated).toBe(2);

    const after = store.getInventory(householdId);
    const remainingTomato = after.lots.filter((lot) => lot.itemKey === "tomato");
    expect(remainingTomato).toHaveLength(1);
    expect(remainingTomato[0]?.quantityRemaining).toBe(1);
    expect(remainingTomato[0]?.lotId).toBe(newestLot.lotId);
    expect(after.events.filter((event) => event.eventType === "consume")).toHaveLength(2);
  });

  it("feeds consumed checkin signal back into planner feedback", async () => {
    const generateWeeklyMock = vi.fn(async () => ({
      model: "planner/mock-v1",
      recommendations: [],
    }));

    const planner: RecommendationPlanner = {
      generateDaily: async () => ({
        model: "planner/mock-v1",
        recommendations: [
          {
            title: "Tomato rice bowl",
            cuisine: "mixed",
            rationale: "use tomato stock",
            itemKeys: ["tomato"],
            score: 0.75,
          },
        ],
      }),
      generateWeekly: generateWeeklyMock,
    };

    const householdId = "household_checkin_feedback";
    const store = new InMemoryJobStore({ recommendationPlanner: planner });
    store.addManualItems(householdId, {
      items: [
        {
          itemKey: "tomato",
          rawName: "Tomato",
          normalizedName: "tomato",
          quantity: 2,
          unit: "count",
          category: "produce",
          confidence: 1,
        },
      ],
    });

    await store.generateDailyRecommendations(householdId, { date: "2026-02-09" });
    const checkinId = store.listPendingCheckins(householdId).checkins[0]?.checkinId;
    if (!checkinId) {
      throw new Error("expected pending checkin");
    }

    store.submitMealCheckin(checkinId, {
      householdId,
      outcome: "made",
      lines: [
        {
          itemKey: "tomato",
          unit: "count",
          quantityConsumed: 1,
        },
      ],
    });

    await store.generateWeeklyRecommendations(householdId, { weekOf: "2026-02-09" });
    expect(generateWeeklyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feedbackByItem: {
          tomato: 0.75,
        },
      }),
    );
  });
});

describe("InMemoryJobStore phase5e shopping drafts", () => {
  it("generates shopping draft items from weekly recommendations with price fields", async () => {
    const householdId = "household_shopping_draft";
    const planner: RecommendationPlanner = {
      generateDaily: async () => ({ model: "planner/mock-v1", recommendations: [] }),
      generateWeekly: async () => ({
        model: "planner/mock-v1",
        recommendations: [
          {
            itemKey: "milk",
            itemName: "Whole Milk",
            quantity: 2,
            unit: "l",
            priority: "high",
            rationale: "Milk is frequently consumed.",
            score: 0.85,
          },
        ],
      }),
    };

    const store = new InMemoryJobStore({ recommendationPlanner: planner });

    const upload = store.createUpload({
      householdId,
      filename: "milk-prices.jpg",
      contentType: "image/jpeg",
    });
    const job = store.enqueueJob({
      householdId,
      receiptUploadId: upload.receiptUploadId,
      request: {
        householdId,
        ocrText: "Milk 2L",
        purchasedAt: "2026-02-08T12:00:00.000Z",
      },
    });
    store.submitJobResult(job.jobId, {
      purchasedAt: "2026-02-08T12:00:00.000Z",
      items: [
        {
          itemKey: "milk",
          rawName: "Whole Milk",
          normalizedName: "whole milk",
          quantity: 2,
          unit: "l",
          category: "dairy",
          confidence: 0.9,
          unitPrice: 2.7,
        },
      ],
    });

    await store.generateWeeklyRecommendations(householdId, { weekOf: "2026-02-09" });
    const generated = await store.generateShoppingDraft(householdId, { weekOf: "2026-02-09" });

    expect(generated.updated).toBe(true);
    expect(generated.draft.items).toHaveLength(1);
    expect(generated.draft.items[0]?.itemKey).toBe("milk");
    expect(generated.draft.items[0]?.lastUnitPrice).toBe(2.7);
    expect(typeof generated.draft.items[0]?.priceAlert).toBe("boolean");
  });

  it("patches and finalizes shopping drafts with idempotent updates", async () => {
    const householdId = "household_shopping_patch";
    const planner: RecommendationPlanner = {
      generateDaily: async () => ({ model: "planner/mock-v1", recommendations: [] }),
      generateWeekly: async () => ({
        model: "planner/mock-v1",
        recommendations: [
          {
            itemKey: "tomato",
            itemName: "Tomato",
            quantity: 4,
            unit: "count",
            priority: "medium",
            rationale: "Required for meals this week.",
            score: 0.72,
          },
        ],
      }),
    };

    const store = new InMemoryJobStore({ recommendationPlanner: planner });
    await store.generateWeeklyRecommendations(householdId, { weekOf: "2026-02-09" });
    const generated = await store.generateShoppingDraft(householdId, { weekOf: "2026-02-09" });
    const draftId = generated.draft.draftId;
    const itemId = generated.draft.items[0]?.draftItemId;
    expect(itemId).toBeDefined();
    if (!itemId) {
      throw new Error("expected shopping draft item");
    }

    const patchedOne = store.patchShoppingDraftItems(draftId, {
      householdId,
      idempotencyKey: "draft-patch-1",
      items: [
        {
          draftItemId: itemId,
          quantity: 5,
          itemStatus: "planned",
          notes: "adjusted quantity",
        },
      ],
    });
    expect(patchedOne?.updated).toBe(true);
    expect(patchedOne?.draft.items[0]?.quantity).toBe(5);

    const patchedTwo = store.patchShoppingDraftItems(draftId, {
      householdId,
      idempotencyKey: "draft-patch-1",
      items: [
        {
          draftItemId: itemId,
          quantity: 5,
        },
      ],
    });
    expect(patchedTwo?.updated).toBe(false);

    const finalized = store.finalizeShoppingDraft(draftId);
    expect(finalized?.updated).toBe(true);
    expect(finalized?.draft.status).toBe("finalized");

    const patchAfterFinalize = store.patchShoppingDraftItems(draftId, {
      householdId,
      items: [
        {
          draftItemId: itemId,
          quantity: 6,
        },
      ],
    });
    expect(patchAfterFinalize?.updated).toBe(false);
    expect(patchAfterFinalize?.draft.items[0]?.quantity).toBe(5);
  });
});
