import { describe, expect, it } from "vitest";
import {
  ClaimJobResponseSchema,
  DailyRecommendationsResponseSchema,
  ReceiptProcessRequestSchema,
  JobStatusResponseSchema,
  JobResultRequestSchema,
  JobStatusSchema,
  RecommendationFeedbackRequestSchema,
  ReceiptDetailsResponseSchema,
  ReceiptItemSchema,
  ReceiptUploadResponseSchema,
} from "./schemas.js";

describe("home inventory contract schemas", () => {
  it("validates receipt upload response", () => {
    const parsed = ReceiptUploadResponseSchema.parse({
      receiptUploadId: "r_123",
      uploadUrl: "https://storage.example/upload",
      path: "receipts/r_123.png",
      expiresAt: "2026-02-08T12:00:00.000Z",
    });

    expect(parsed.receiptUploadId).toBe("r_123");
  });

  it("validates claimed job payload with receipt context", () => {
    const parsed = ClaimJobResponseSchema.parse({
      job: {
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
          ocrText: "rice 2kg",
        },
      },
    });

    expect(parsed.job?.receipt.ocrText).toBe("rice 2kg");
  });

  it("rejects invalid job status", () => {
    const result = JobStatusSchema.safeParse("pending");
    expect(result.success).toBe(false);
  });

  it("requires normalized items for submitted job results", () => {
    const item = ReceiptItemSchema.parse({
      itemKey: "rice",
      rawName: "Rice",
      normalizedName: "rice",
      quantity: 2,
      unit: "kg",
      category: "grain",
      confidence: 0.9,
    });

    const parsed = JobResultRequestSchema.parse({
      merchantName: "Local Store",
      items: [item],
    });

    expect(parsed.items[0]?.itemKey).toBe("rice");
  });

  it("accepts vision-ready receipt processing input", () => {
    const parsed = ReceiptProcessRequestSchema.parse({
      householdId: "household_1",
      receiptImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      merchantName: "Vision Market",
    });

    expect(parsed.receiptImageDataUrl?.startsWith("data:image/")).toBe(true);
  });

  it("validates receipt details with parsed items", () => {
    const parsed = ReceiptDetailsResponseSchema.parse({
      receipt: {
        receiptUploadId: "receipt_1",
        householdId: "household_1",
        filename: "receipt.jpg",
        contentType: "image/jpeg",
        path: "receipts/household_1/receipt_1/receipt.jpg",
        status: "parsed",
        createdAt: "2026-02-08T12:00:00.000Z",
        updatedAt: "2026-02-08T12:01:00.000Z",
        items: [
          {
            itemKey: "tomato",
            rawName: "Tomato",
            normalizedName: "tomato",
            quantity: 3,
            unit: "count",
            category: "produce",
            confidence: 0.7,
          },
        ],
      },
    });

    expect(parsed.receipt.items?.length).toBe(1);
  });

  it("validates daily recommendation response", () => {
    const parsed = DailyRecommendationsResponseSchema.parse({
      run: {
        runId: "run_1",
        householdId: "household_1",
        runType: "daily",
        model: "openai/gpt-5.2-mini",
        createdAt: "2026-02-08T12:00:00.000Z",
        targetDate: "2026-02-09",
      },
      recommendations: [
        {
          recommendationId: "rec_1",
          householdId: "household_1",
          mealDate: "2026-02-09",
          title: "Tomato rice bowl",
          cuisine: "chinese",
          rationale: "Uses expiring produce first.",
          itemKeys: ["tomato", "rice"],
          score: 0.85,
        },
      ],
    });

    expect(parsed.recommendations[0]?.score).toBe(0.85);
  });

  it("validates recommendation feedback request", () => {
    const parsed = RecommendationFeedbackRequestSchema.parse({
      householdId: "household_1",
      signalType: "accepted",
      signalValue: 1,
      context: "Cooked this for dinner",
    });

    expect(parsed.signalType).toBe("accepted");
  });

  it("validates job status response payload", () => {
    const parsed = JobStatusResponseSchema.parse({
      job: {
        jobId: "job_1",
        receiptUploadId: "receipt_1",
        householdId: "household_1",
        status: "queued",
        attempts: 1,
        createdAt: "2026-02-08T12:00:00.000Z",
        updatedAt: "2026-02-08T12:00:01.000Z",
      },
    });

    expect(parsed.job.status).toBe("queued");
  });
});
