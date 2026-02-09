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
