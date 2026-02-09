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

export type PlannerLlmProvider =
  | "openai"
  | "openrouter"
  | "gemini"
  | "lmstudio"
  | "openai-compatible";
export type PlannerRequestMode = "responses" | "chat_completions";

export type PlannerLlmConfig = {
  provider: PlannerLlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  requestMode: PlannerRequestMode;
  extraHeaders: Record<string, string>;
};

const SUPPORTED_PROVIDERS: PlannerLlmProvider[] = [
  "openai",
  "openrouter",
  "gemini",
  "lmstudio",
  "openai-compatible",
];

export function createRecommendationPlannerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RecommendationPlanner {
  const fallback = new HeuristicRecommendationPlanner();
  const config = resolvePlannerLlmConfigFromEnv(env);
  if (!config) {
    return fallback;
  }

  return new LlmRecommendationPlanner({
    config,
    fallback,
  });
}

export function resolvePlannerLlmConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PlannerLlmConfig | null {
  const provider = parseProvider(env.HOME_INVENTORY_LLM_PROVIDER);
  const apiKey = resolveProviderApiKey(provider, env);
  const requiresApiKey =
    provider === "openai" || provider === "openrouter" || provider === "gemini";
  if (requiresApiKey && !apiKey) {
    return null;
  }

  const model =
    env.HOME_INVENTORY_PLANNER_MODEL?.trim() ||
    env.HOME_INVENTORY_LLM_MODEL?.trim() ||
    defaultModel(provider);

  const baseUrl =
    env.HOME_INVENTORY_PLANNER_BASE_URL?.trim() ||
    env.HOME_INVENTORY_LLM_BASE_URL?.trim() ||
    env.HOME_INVENTORY_OPENAI_BASE_URL?.trim();

  const requestMode = resolveRequestMode(
    env.HOME_INVENTORY_PLANNER_REQUEST_MODE || env.HOME_INVENTORY_LLM_REQUEST_MODE,
    provider,
  );

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    requestMode,
    extraHeaders: resolveProviderHeaders(provider, env),
  };
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

type LlmRecommendationPlannerOptions = {
  config: PlannerLlmConfig;
  timeoutMs?: number;
  fallback: RecommendationPlanner;
};

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type ResponsesPayload = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

class LlmRecommendationPlanner implements RecommendationPlanner {
  private readonly provider: PlannerLlmProvider;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly requestMode: PlannerRequestMode;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fallback: RecommendationPlanner;

  constructor(options: LlmRecommendationPlannerOptions) {
    this.provider = options.config.provider;
    this.apiKey = options.config.apiKey?.trim() || undefined;
    this.model = options.config.model;
    this.baseUrl = resolveBaseUrl(options.config.provider, options.config.baseUrl);
    this.requestMode = options.config.requestMode;
    this.extraHeaders = sanitizeHeaders(options.config.extraHeaders);
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.fallback = options.fallback;
  }

  async generateDaily(
    input: RecommendationPlannerInput,
  ): Promise<{ model: string; recommendations: DailyMealRecommendationDraft[] }> {
    try {
      const response = await this.callModel({
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
      const response = await this.callModel({
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

  private async callModel(params: {
    systemPrompt: string;
    schema: Record<string, unknown>;
    userContext: string;
  }): Promise<{ recommendations: Array<Record<string, unknown>> }> {
    const text =
      this.requestMode === "chat_completions"
        ? await this.callChatCompletions(params)
        : await this.callResponses(params);

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
  }

  private async callResponses(params: {
    systemPrompt: string;
    schema: Record<string, unknown>;
    userContext: string;
  }): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: this.buildHeaders(),
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
        throw new Error(
          `planner request failed via responses (${this.provider}, ${response.status}): ${await response.text()}`,
        );
      }

      const payload = (await response.json()) as ResponsesPayload;
      return extractOutputText(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callChatCompletions(params: {
    systemPrompt: string;
    schema: Record<string, unknown>;
    userContext: string;
  }): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: params.systemPrompt,
            },
            {
              role: "user",
              content: params.userContext,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "home_inventory_recommendations",
              strict: true,
              schema: params.schema,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `planner request failed via chat_completions (${this.provider}, ${response.status}): ${await response.text()}`,
        );
      }

      const payload = (await response.json()) as ChatCompletionsPayload;
      return extractChatCompletionText(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
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

function parseProvider(value: string | undefined): PlannerLlmProvider {
  const lowered = value?.trim().toLowerCase();
  if (!lowered) {
    return "openai";
  }

  const matched = SUPPORTED_PROVIDERS.find((provider) => provider === lowered);
  return matched ?? "openai";
}

function resolveRequestMode(
  value: string | undefined,
  provider: PlannerLlmProvider,
): PlannerRequestMode {
  if (value === "responses" || value === "chat_completions") {
    return value;
  }

  switch (provider) {
    case "openrouter":
    case "gemini":
    case "lmstudio":
    case "openai-compatible":
      return "chat_completions";
    case "openai":
    default:
      return "responses";
  }
}

function resolveProviderApiKey(
  provider: PlannerLlmProvider,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicit =
    env.HOME_INVENTORY_PLANNER_API_KEY?.trim() || env.HOME_INVENTORY_LLM_API_KEY?.trim();
  if (explicit) {
    return explicit;
  }

  switch (provider) {
    case "openrouter":
      return env.OPENROUTER_API_KEY?.trim() || undefined;
    case "gemini":
      return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
    case "openai":
      return env.OPENAI_API_KEY?.trim() || undefined;
    case "lmstudio":
    case "openai-compatible":
      return undefined;
    default:
      return undefined;
  }
}

function resolveProviderHeaders(
  provider: PlannerLlmProvider,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (provider !== "openrouter") {
    return {};
  }

  const referer =
    env.HOME_INVENTORY_OPENROUTER_SITE_URL?.trim() || env.OPENROUTER_HTTP_REFERER?.trim();
  const appName = env.HOME_INVENTORY_OPENROUTER_APP_NAME?.trim() || env.OPENROUTER_APP_NAME?.trim();
  const headers: Record<string, string> = {};

  if (referer) {
    headers["HTTP-Referer"] = referer;
  }
  if (appName) {
    headers["X-Title"] = appName;
  }

  return headers;
}

function defaultModel(provider: PlannerLlmProvider): string {
  switch (provider) {
    case "gemini":
      return "gemini-2.5-flash";
    case "openrouter":
      return "openai/gpt-4o-mini";
    case "lmstudio":
    case "openai-compatible":
      return "local-model";
    case "openai":
    default:
      return "gpt-5.2-mini";
  }
}

function resolveBaseUrl(provider: PlannerLlmProvider, override?: string): string {
  const normalizedOverride = override?.trim();
  if (normalizedOverride) {
    return normalizedOverride.replace(/\/$/, "");
  }

  switch (provider) {
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "lmstudio":
    case "openai-compatible":
      return "http://127.0.0.1:1234/v1";
    case "openai":
    default:
      return "https://api.openai.com/v1";
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerKey = key.trim();
    const headerValue = value.trim();
    if (headerKey.length > 0 && headerValue.length > 0) {
      sanitized[headerKey] = headerValue;
    }
  }
  return sanitized;
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

function extractOutputText(payload: ResponsesPayload): string | null {
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

function extractChatCompletionText(payload: ChatCompletionsPayload): string | null {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const chunk of content) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    const text = (chunk as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
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
