import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecommendationPlannerFromEnv,
  resolvePlannerLlmConfigFromEnv,
} from "./recommendation-planner.js";

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

  it("uses chat completions path for OpenRouter-style providers", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: [
                    {
                      itemKey: "jasmine-rice",
                      itemName: "Jasmine Rice",
                      quantity: 1.5,
                      unit: "kg",
                      priority: "high",
                      rationale: "High weekly usage trend.",
                      score: 0.88,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const planner = createRecommendationPlannerFromEnv({
      HOME_INVENTORY_LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-key",
      HOME_INVENTORY_PLANNER_MODEL: "openai/gpt-4o-mini",
      HOME_INVENTORY_OPENROUTER_SITE_URL: "https://inventory.example.com",
      HOME_INVENTORY_OPENROUTER_APP_NAME: "InventoryAgent",
    });

    const weekly = await planner.generateWeekly(INVENTORY_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected one fetch invocation");
    }

    expect(String(firstCall[0])).toContain("/chat/completions");
    const requestHeaders = (firstCall[1] as RequestInit).headers as Record<string, string>;
    expect(requestHeaders.authorization).toBe("Bearer or-key");
    expect(requestHeaders["HTTP-Referer"]).toBe("https://inventory.example.com");
    expect(requestHeaders["X-Title"]).toBe("InventoryAgent");

    expect(weekly.model).toBe("openai/gpt-4o-mini");
    expect(weekly.recommendations[0]?.itemKey).toBe("jasmine-rice");
  });

  it("resolves LM Studio config without requiring API key", () => {
    const config = resolvePlannerLlmConfigFromEnv({
      HOME_INVENTORY_LLM_PROVIDER: "lmstudio",
      HOME_INVENTORY_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      HOME_INVENTORY_PLANNER_MODEL: "qwen2.5-7b-instruct",
    });

    expect(config?.provider).toBe("lmstudio");
    expect(config?.requestMode).toBe("chat_completions");
    expect(config?.apiKey).toBeUndefined();
    expect(config?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
});
