import type { DraftReceiptItem, ReceiptExtractionInput, ReceiptExtractor } from "./types.js";

type OpenAiReceiptExtractorOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
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
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiReceiptExtractorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 25000;
  }

  async extract(input: ReceiptExtractionInput): Promise<DraftReceiptItem[]> {
    if (input.ocrText.trim().length === 0) {
      return [];
    }

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
              text: `Merchant: ${input.merchantName ?? "unknown"}\nOCR:\n${input.ocrText}`,
            },
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI receipt extraction failed (${response.status}): ${body}`);
      }

      const parsed = (await response.json()) as ResponsesApiPayload;
      const rawText = extractOutputText(parsed);
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
    } finally {
      clearTimeout(timeout);
    }
  }
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
