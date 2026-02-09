import type { ClaimedJob } from "@openclaw/home-inventory-contracts";
import { describe, expect, it } from "vitest";
import type { ReceiptExtractor } from "./types.js";
import { PhaseTwoReceiptProcessor, resolveReceiptLlmConfigFromEnv } from "./receipt-processor.js";

function claimedJob(ocrText = "Rice 2kg\nTomato x3"): ClaimedJob {
  return {
    job: {
      jobId: "job_1",
      receiptUploadId: "receipt_1",
      householdId: "household_1",
      status: "processing",
      attempts: 1,
      createdAt: "2026-02-08T12:00:00.000Z",
      updatedAt: "2026-02-08T12:01:00.000Z",
    },
    receipt: {
      receiptUploadId: "receipt_1",
      householdId: "household_1",
      filename: "receipt.jpg",
      contentType: "image/jpeg",
      path: "receipts/household_1/receipt_1/receipt.jpg",
      status: "processing",
      createdAt: "2026-02-08T12:00:00.000Z",
      updatedAt: "2026-02-08T12:01:00.000Z",
      ocrText,
      merchantName: "Fresh Market",
      purchasedAt: "2026-02-08T12:00:00.000Z",
    },
  };
}

describe("PhaseTwoReceiptProcessor", () => {
  it("normalizes extractor output into submit payload", async () => {
    const primary: ReceiptExtractor = {
      extract: async () => [
        { rawName: "Jasmine Rice", quantity: 2, unit: "kg", confidence: 0.8 },
        { rawName: "Tomato", quantity: 3, unit: "x" },
      ],
    };

    const fallback: ReceiptExtractor = {
      extract: async () => [],
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: primary,
      fallbackExtractor: fallback,
    });

    const result = await processor.process(claimedJob());

    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.itemKey === "jasmine-rice")?.category).toBe("grain");
    expect(result.notes).toContain("phase2 extracted");
  });

  it("falls back when primary extractor fails", async () => {
    const primary: ReceiptExtractor = {
      extract: async () => {
        throw new Error("provider timeout");
      },
    };

    const fallback: ReceiptExtractor = {
      extract: async () => [{ rawName: "Milk", quantity: 1, unit: "l" }],
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: primary,
      fallbackExtractor: fallback,
    });

    const result = await processor.process(claimedJob("Milk 1L"));
    expect(result.items[0]?.itemKey).toBe("milk");
    expect(result.items[0]?.category).toBe("dairy");
  });

  it("throws when receipt has neither OCR text nor image data", async () => {
    const extractor: ReceiptExtractor = {
      extract: async () => [{ rawName: "Rice", quantity: 1 }],
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: extractor,
      fallbackExtractor: extractor,
    });

    await expect(processor.process(claimedJob(""))).rejects.toThrow(
      "has neither OCR text nor image data",
    );
  });

  it("accepts image-only receipts for extraction", async () => {
    const extractor: ReceiptExtractor = {
      extract: async () => [{ rawName: "Olive Oil", quantity: 1, unit: "bottle" }],
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: extractor,
      fallbackExtractor: extractor,
    });

    const job = claimedJob("");
    job.receipt.receiptImageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

    const result = await processor.process(job);
    expect(result.items[0]?.itemKey).toBe("olive-oil");
  });

  it("passes preprocessed image data to extractor when available", async () => {
    let extractedImageDataUrl: string | undefined;
    const extractor: ReceiptExtractor = {
      extract: async (input) => {
        extractedImageDataUrl = input.receiptImageDataUrl;
        return [{ rawName: "Olive Oil", quantity: 1, unit: "bottle" }];
      },
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: extractor,
      fallbackExtractor: extractor,
      imagePreprocessor: {
        preprocess: async () => "data:image/jpeg;base64,processed",
      },
    });

    const job = claimedJob("");
    job.receipt.receiptImageDataUrl = "data:image/png;base64,original";

    await processor.process(job);
    expect(extractedImageDataUrl).toBe("data:image/jpeg;base64,processed");
  });

  it("resolves OpenRouter config from env with OpenRouter headers", () => {
    const config = resolveReceiptLlmConfigFromEnv({
      HOME_INVENTORY_LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-test",
      HOME_INVENTORY_EXTRACTOR_MODEL: "openai/gpt-4o-mini",
      HOME_INVENTORY_OPENROUTER_SITE_URL: "https://app.example.com",
      HOME_INVENTORY_OPENROUTER_APP_NAME: "InventoryAgent",
    });

    expect(config?.provider).toBe("openrouter");
    expect(config?.requestMode).toBe("chat_completions");
    expect(config?.apiKey).toBe("or-test");
    expect(config?.extraHeaders["HTTP-Referer"]).toBe("https://app.example.com");
    expect(config?.extraHeaders["X-Title"]).toBe("InventoryAgent");
  });

  it("allows LM Studio config without API key", () => {
    const config = resolveReceiptLlmConfigFromEnv({
      HOME_INVENTORY_LLM_PROVIDER: "lmstudio",
      HOME_INVENTORY_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      HOME_INVENTORY_EXTRACTOR_MODEL: "qwen2.5-7b-instruct",
    });

    expect(config?.provider).toBe("lmstudio");
    expect(config?.requestMode).toBe("chat_completions");
    expect(config?.apiKey).toBeUndefined();
    expect(config?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
});
