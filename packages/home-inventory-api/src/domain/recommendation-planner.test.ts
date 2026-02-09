import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecommendationPlannerFromEnv } from "./recommendation-planner.js";

const INVENTORY_INPUT = {
  householdId: "household_main",
  targetDate: "2026-02-09",
  inventory: {
    householdId: "household_main",
    lots: [
      {
        lotId: "lot_1",
        householdId: "household_main",
        itemKey: "jasmine-rice",
        itemName: "jasmine rice",
        category: "grain",
        quantityPurchased: 2,
        quantityRemaining: 0.4,
        unit: "kg" as const,
        purchaseDate: "2026-02-08",
        expiryDate: null,
        sourceReceiptUploadId: "receipt_1",
        createdAt: "2026-02-08T12:00:00.000Z",
      },
    ],
    events: [],
  },
  feedbackByItem: {
    "jasmine-rice": 0.5,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recommendation planner", () => {
  it("uses heuristic planner when OpenAI API key is absent", async () => {
    const planner = createRecommendationPlannerFromEnv({});

    const daily = await planner.generateDaily(INVENTORY_INPUT);
    const weekly = await planner.generateWeekly(INVENTORY_INPUT);

    expect(daily.model).toBe("heuristic/home-inventory-v1");
    expect(daily.recommendations.length).toBeGreaterThan(0);
    expect(weekly.model).toBe("heuristic/home-inventory-v1");
    expect(weekly.recommendations.length).toBeGreaterThan(0);
  });

  it("falls back to heuristic planner when OpenAI request fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const planner = createRecommendationPlannerFromEnv({
      OPENAI_API_KEY: "test-key",
      HOME_INVENTORY_PLANNER_MODEL: "gpt-5.2-mini",
    });

    const weekly = await planner.generateWeekly(INVENTORY_INPUT);

    expect(fetchMock).toHaveBeenCalled();
    expect(weekly.model).toBe("heuristic/home-inventory-v1");
    expect(weekly.recommendations.length).toBeGreaterThan(0);
  });
});
