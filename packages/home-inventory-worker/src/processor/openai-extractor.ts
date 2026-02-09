import type { DraftReceiptItem, ReceiptExtractionInput, ReceiptExtractor } from "./types.js";

export type SupportedLlmProvider =
  | "openai"
  | "openrouter"
  | "gemini"
  | "lmstudio"
  | "openai-compatible";
export type LlmRequestMode = "responses" | "chat_completions";

type OpenAiReceiptExtractorOptions = {
  provider?: SupportedLlmProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  requestMode?: LlmRequestMode;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
};

type ResponsesApiPayload = {
  input?: unknown;
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

const ITEM_ARRAY_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      rawName: { type: "string" },
      normalizedName: { type: "string" },
      quantity: { type: "number" },
      unit: { type: "string" },
      category: { type: "string" },
      confidence: { type: "number" },
      unitPrice: { type: "number" },
      lineTotal: { type: "number" },
    },
    required: ["rawName"],
  },
};

export class OpenAiReceiptExtractor implements ReceiptExtractor {
  private readonly provider: SupportedLlmProvider;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly requestMode: LlmRequestMode;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: OpenAiReceiptExtractorOptions) {
    this.provider = options.provider ?? "openai";
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model;
    this.baseUrl = resolveBaseUrl(this.provider, options.baseUrl);
    this.requestMode = options.requestMode ?? defaultRequestMode(this.provider);
    this.extraHeaders = sanitizeHeaders(options.extraHeaders);
    this.timeoutMs = options.timeoutMs ?? 25000;
  }

  async extract(input: ReceiptExtractionInput): Promise<DraftReceiptItem[]> {
    const normalizedImageDataUrl = normalizeImageDataUrl(input.receiptImageDataUrl);
    if (input.ocrText.trim().length === 0 && !normalizedImageDataUrl) {
      return [];
    }

    const userText = buildUserText(input.merchantName, input.ocrText);
    const payload = {
      model: this.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "Extract grocery and household line items from OCR text.",
                "Return only a JSON array of items.",
                "Each item should include rawName and optional normalizedName, quantity, unit, category, confidence, unitPrice, and lineTotal.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userText,
            },
            ...(normalizedImageDataUrl
              ? [
                  {
                    type: "input_image",
                    image_url: normalizedImageDataUrl,
                  },
                ]
              : []),
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_items",
          strict: true,
          schema: ITEM_ARRAY_SCHEMA,
        },
      },
    };

    const rawText =
      this.requestMode === "chat_completions"
        ? await this.callChatCompletionsApi({
            ...input,
            receiptImageDataUrl: normalizedImageDataUrl,
          })
        : await this.callResponsesApi(payload);

    if (!rawText) {
      return [];
    }

    const data = parseItemsJson(rawText);
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          rawName: toStringOr(record.rawName, ""),
          normalizedName: toOptionalString(record.normalizedName),
          quantity: toOptionalNumber(record.quantity),
          unit: toOptionalString(record.unit),
          category: toOptionalString(record.category),
          confidence: toOptionalNumber(record.confidence),
          unitPrice: toOptionalNumber(record.unitPrice),
          lineTotal: toOptionalNumber(record.lineTotal),
        } satisfies DraftReceiptItem;
      })
      .filter((item) => item.rawName.trim().length > 0);
  }

  private async callResponsesApi(payload: Record<string, unknown>): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `receipt extraction failed via responses (${this.provider}, ${response.status}): ${body}`,
        );
      }

      const parsed = (await response.json()) as ResponsesApiPayload;
      return extractOutputText(parsed);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callChatCompletionsApi(input: ReceiptExtractionInput): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const userText = buildUserText(input.merchantName, input.ocrText);
      const userContent = input.receiptImageDataUrl
        ? [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: input.receiptImageDataUrl },
            },
          ]
        : userText;

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: [
                "Extract grocery and household line items from OCR text.",
                "Return only a JSON array of items.",
                "Each item should include rawName and optional normalizedName, quantity, unit, category, confidence, unitPrice, and lineTotal.",
              ].join(" "),
            },
            {
              role: "user",
              content: userContent,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "receipt_items",
              strict: true,
              schema: ITEM_ARRAY_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `receipt extraction failed via chat_completions (${this.provider}, ${response.status}): ${body}`,
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

function defaultRequestMode(provider: SupportedLlmProvider): LlmRequestMode {
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

function resolveBaseUrl(provider: SupportedLlmProvider, override?: string): string {
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

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) {
    return {};
  }

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

function extractOutputText(payload: ResponsesApiPayload): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return null;
  }

  const chunks: string[] = [];
  for (const entry of payload.output) {
    if (!Array.isArray(entry.content)) {
      continue;
    }
    for (const content of entry.content) {
      if (typeof content.text === "string" && content.text.length > 0) {
        chunks.push(content.text);
      }
    }
  }

  if (chunks.length === 0) {
    return null;
  }
  return chunks.join("\n");
}

function extractChatCompletionText(payload: ChatCompletionsPayload): string | null {
  const firstMessage = payload.choices?.[0]?.message?.content;
  if (typeof firstMessage === "string" && firstMessage.length > 0) {
    return firstMessage;
  }

  if (!Array.isArray(firstMessage)) {
    return null;
  }

  const parts: string[] = [];
  for (const chunk of firstMessage) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    const text = (chunk as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function normalizeImageDataUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("data:image/")) {
    return undefined;
  }
  return trimmed;
}

function buildUserText(merchantName: string | undefined, ocrText: string): string {
  const normalizedOcrText = ocrText.trim();
  const ocrSection =
    normalizedOcrText.length > 0
      ? normalizedOcrText
      : "[not provided; use attached receipt image as primary source]";
  return `Merchant: ${merchantName ?? "unknown"}\nOCR:\n${ocrSection}`;
}

function parseItemsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const candidate = raw.slice(start, end + 1);
      return JSON.parse(candidate);
    }
    throw new Error(`unable to parse extractor payload: ${raw.slice(0, 120)}`);
  }
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}
