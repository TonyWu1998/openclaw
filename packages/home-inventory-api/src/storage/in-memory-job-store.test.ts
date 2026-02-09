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
