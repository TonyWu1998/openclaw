import { describe, expect, it } from "vitest";
import type { ClaimedJob, JobResultRequest } from "@openclaw/home-inventory-contracts";
import { PhaseTwoReceiptProcessor } from "./receipt-processor.js";
import type { ReceiptExtractor } from "./types.js";

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

    const result = (await processor.process(claimedJob("Milk 1L"))) as JobResultRequest;
    expect(result.items[0]?.itemKey).toBe("milk");
    expect(result.items[0]?.category).toBe("dairy");
  });

  it("throws when receipt has no OCR text", async () => {
    const extractor: ReceiptExtractor = {
      extract: async () => [{ rawName: "Rice", quantity: 1 }],
    };

    const processor = new PhaseTwoReceiptProcessor({
      primaryExtractor: extractor,
      fallbackExtractor: extractor,
    });

    await expect(processor.process(claimedJob(""))).rejects.toThrow("has no OCR text");
  });
});
