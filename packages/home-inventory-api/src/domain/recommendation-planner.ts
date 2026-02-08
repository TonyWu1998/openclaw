import type {
  InventorySnapshotResponse,
  RecommendationPriority,
  Unit,
} from "@openclaw/home-inventory-contracts";

type RecommendationPlannerInput = {
  householdId: string;
  targetDate: string;
  inventory: InventorySnapshotResponse;
  feedbackByItem: Record<string, number>;
};

export type DailyMealRecommendationDraft = {
  title: string;
  cuisine: string;
  rationale: string;
  itemKeys: string[];
  score: number;
};

export type WeeklyPurchaseRecommendationDraft = {
  itemKey: string;
  itemName: string;
  quantity: number;
  unit: Unit;
  priority: RecommendationPriority;
  rationale: string;
  score: number;
};

export type RecommendationPlanner = {
  generateDaily: (
    input: RecommendationPlannerInput,
  ) => Promise<{ model: string; recommendations: DailyMealRecommendationDraft[] }>;
  generateWeekly: (
    input: RecommendationPlannerInput,
  ) => Promise<{ model: string; recommendations: WeeklyPurchaseRecommendationDraft[] }>;
};

export function createRecommendationPlannerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RecommendationPlanner {
  const fallback = new HeuristicRecommendationPlanner();
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return fallback;
  }

  const model = env.HOME_INVENTORY_PLANNER_MODEL?.trim() || "gpt-5.2-mini";
  const baseUrl = env.HOME_INVENTORY_OPENAI_BASE_URL?.trim();

  return new OpenAiRecommendationPlanner({
    apiKey,
    model,
    baseUrl,
    fallback,
  });
}

class HeuristicRecommendationPlanner implements RecommendationPlanner {
  async generateDaily(
    input: RecommendationPlannerInput,
  ): Promise<{ model: string; recommendations: DailyMealRecommendationDraft[] }> {
    const candidates = input.inventory.lots
      .filter((lot) => lot.quantityRemaining > 0)
      .toSorted((a, b) => b.quantityRemaining - a.quantityRemaining)
      .slice(0, 4);

    const recommendations = candidates.map((lot) => {
      const cuisine = guessCuisine(lot.itemName, lot.category);
      const feedbackAdjustment = input.feedbackByItem[lot.itemKey] ?? 0;
      const score = clampScore(
        0.45 + Math.min(0.4, lot.quantityRemaining / 10) + feedbackAdjustment * 0.2,
      );

      return {
        title: `${capitalize(cuisine)} ${lot.itemName} dinner`,
        cuisine,
        rationale: `Uses stocked ${lot.itemName} and adapts to prior feedback (${feedbackAdjustment.toFixed(2)}).`,
        itemKeys: [lot.itemKey],
        score,
      } satisfies DailyMealRecommendationDraft;
    });

    return {
      model: "heuristic/home-inventory-v1",
      recommendations,
    };
  }

  async generateWeekly(
    input: RecommendationPlannerInput,
  ): Promise<{ model: string; recommendations: WeeklyPurchaseRecommendationDraft[] }> {
    const recommendations: WeeklyPurchaseRecommendationDraft[] = [];

    for (const lot of input.inventory.lots) {
      const threshold = lowStockThreshold(lot.unit);
      if (lot.quantityRemaining >= threshold) {
        continue;
      }

      const deficit = threshold - lot.quantityRemaining;
      const feedbackAdjustment = input.feedbackByItem[lot.itemKey] ?? 0;
      const suggestedQuantity = normalizeQuantity(deficit + threshold * 0.5, lot.unit);
      const score = clampScore(
        0.5 + Math.min(0.4, deficit / Math.max(threshold, 1)) + feedbackAdjustment * 0.2,
      );
      const priority: RecommendationPriority =
        score > 0.8 ? "high" : score > 0.6 ? "medium" : "low";

      recommendations.push({
        itemKey: lot.itemKey,
        itemName: lot.itemName,
        quantity: suggestedQuantity,
        unit: lot.unit,
        priority,
        rationale: `Stock is below target (${lot.quantityRemaining} ${lot.unit} < ${threshold} ${lot.unit}).`,
        score,
      });
    }

    return {
      model: "heuristic/home-inventory-v1",
      recommendations: recommendations.toSorted((a, b) => b.score - a.score),
    };
  }
}

type OpenAiRecommendationPlannerOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fallback: RecommendationPlanner;
};

class OpenAiRecommendationPlanner implements RecommendationPlanner {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fallback: RecommendationPlanner;

  constructor(options: OpenAiRecommendationPlannerOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.fallback = options.fallback;
  }

  async generateDaily(
    input: RecommendationPlannerInput,
  ): Promise<{ model: string; recommendations: DailyMealRecommendationDraft[] }> {
    try {
      const response = await this.callResponsesApi({
        systemPrompt:
          "You are a home-inventory meal planner. Return concise JSON with dinner suggestions that prioritize existing stock and previous feedback.",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  cuisine: { type: "string" },
                  rationale: { type: "string" },
                  itemKeys: { type: "array", items: { type: "string" } },
                  score: { type: "number" },
                },
                required: ["title", "cuisine", "rationale", "itemKeys", "score"],
              },
            },
          },
          required: ["recommendations"],
        },
        userContext: buildPlannerContext(input, "daily"),
      });

      return {
        model: this.model,
        recommendations: response.recommendations
          .map((entry) => ({
            title: safeString(entry.title, "Inventory dinner"),
            cuisine: safeString(entry.cuisine, "mixed"),
            rationale: safeString(entry.rationale, "Generated from inventory state."),
            itemKeys: normalizeItemKeys(entry.itemKeys),
            score: clampScore(toNumber(entry.score, 0.5)),
          }))
          .filter((entry) => entry.itemKeys.length > 0),
      };
    } catch {
      return this.fallback.generateDaily(input);
    }
  }

  async generateWeekly(
    input: RecommendationPlannerInput,
  ): Promise<{ model: string; recommendations: WeeklyPurchaseRecommendationDraft[] }> {
    try {
      const response = await this.callResponsesApi({
        systemPrompt:
          "You are a home-inventory purchase planner. Return concise JSON with weekly purchase recommendations based on stock gaps and feedback.",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  itemKey: { type: "string" },
                  itemName: { type: "string" },
                  quantity: { type: "number" },
                  unit: { type: "string" },
                  priority: { type: "string", enum: ["high", "medium", "low"] },
                  rationale: { type: "string" },
                  score: { type: "number" },
                },
                required: [
                  "itemKey",
                  "itemName",
                  "quantity",
                  "unit",
                  "priority",
                  "rationale",
                  "score",
                ],
              },
            },
          },
          required: ["recommendations"],
        },
        userContext: buildPlannerContext(input, "weekly"),
      });

      return {
        model: this.model,
        recommendations: response.recommendations.map((entry) => ({
          itemKey: safeString(entry.itemKey, "unknown-item"),
          itemName: safeString(entry.itemName, "Unknown item"),
          quantity: normalizeQuantity(toNumber(entry.quantity, 1), normalizeUnit(entry.unit)),
          unit: normalizeUnit(entry.unit),
          priority: normalizePriority(entry.priority),
          rationale: safeString(entry.rationale, "Generated from stock analysis."),
          score: clampScore(toNumber(entry.score, 0.5)),
        })),
      };
    } catch {
      return this.fallback.generateWeekly(input);
    }
  }

  private async callResponsesApi(params: {
    systemPrompt: string;
    schema: Record<string, unknown>;
    userContext: string;
  }): Promise<{ recommendations: Array<Record<string, unknown>> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: params.systemPrompt }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: params.userContext }],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "home_inventory_recommendations",
              strict: true,
              schema: params.schema,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI planner failed (${response.status}): ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };

      const text = extractOutputText(payload);
      if (!text) {
        throw new Error("planner returned empty payload");
      }

      const parsed = parseJson(text);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("planner returned invalid payload");
      }

      const recommendations = (parsed as { recommendations?: unknown }).recommendations;
      if (!Array.isArray(recommendations)) {
        throw new Error("planner payload missing recommendations array");
      }

      return {
        recommendations: recommendations.filter(
          (entry) => entry && typeof entry === "object",
        ) as Array<Record<string, unknown>>,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildPlannerContext(
  input: RecommendationPlannerInput,
  runType: "daily" | "weekly",
): string {
  return JSON.stringify(
    {
      runType,
      householdId: input.householdId,
      targetDate: input.targetDate,
      inventoryLots: input.inventory.lots,
      feedbackByItem: input.feedbackByItem,
    },
    null,
    2,
  );
}

function guessCuisine(itemName: string, category: string): string {
  const lowered = `${itemName} ${category}`.toLowerCase();
  if (lowered.includes("rice") || lowered.includes("soy") || lowered.includes("tofu")) {
    return "chinese";
  }
  if (lowered.includes("pasta") || lowered.includes("tomato") || lowered.includes("olive")) {
    return "italian";
  }
  return "mixed";
}

function lowStockThreshold(unit: Unit): number {
  switch (unit) {
    case "count":
      return 4;
    case "kg":
    case "l":
    case "lb":
      return 1;
    case "pack":
    case "box":
    case "bottle":
      return 2;
    default:
      return 2;
  }
}

function normalizeUnit(value: unknown): Unit {
  const unit = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (unit === "g") {
    return "g";
  }
  if (unit === "kg") {
    return "kg";
  }
  if (unit === "ml") {
    return "ml";
  }
  if (unit === "l") {
    return "l";
  }
  if (unit === "oz") {
    return "oz";
  }
  if (unit === "lb") {
    return "lb";
  }
  if (unit === "pack") {
    return "pack";
  }
  if (unit === "box") {
    return "box";
  }
  if (unit === "bottle") {
    return "bottle";
  }
  return "count";
}

function normalizePriority(value: unknown): RecommendationPriority {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

function normalizeItemKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeQuantity(value: number, unit: Unit): number {
  const defaultQuantity = unit === "count" ? 1 : 0.5;
  if (!Number.isFinite(value) || value <= 0) {
    return defaultQuantity;
  }
  return Number.parseFloat(value.toFixed(2));
}

function safeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number.parseFloat(value.toFixed(3));
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function extractOutputText(payload: {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return null;
  }

  const parts: string[] = [];
  for (const output of payload.output) {
    if (!Array.isArray(output.content)) {
      continue;
    }
    for (const content of output.content) {
      if (typeof content.text === "string" && content.text.length > 0) {
        parts.push(content.text);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`failed to parse planner JSON payload: ${text.slice(0, 120)}`);
  }
}
