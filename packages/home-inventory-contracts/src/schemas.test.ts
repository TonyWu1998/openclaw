import { describe, expect, it } from "vitest";
import {
  FailJobRequestSchema,
  JobStatusSchema,
  ReceiptProcessJobSchema,
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

  it("rejects invalid job status", () => {
    const result = JobStatusSchema.safeParse("pending");
    expect(result.success).toBe(false);
  });

  it("requires error message on failed job payload", () => {
    const result = FailJobRequestSchema.safeParse({ error: "" });
    expect(result.success).toBe(false);
  });

  it("allows optional error field on job record", () => {
    const parsed = ReceiptProcessJobSchema.parse({
      jobId: "job_1",
      receiptUploadId: "receipt_1",
      householdId: "household_1",
      status: "failed",
      attempts: 1,
      createdAt: "2026-02-08T12:00:00.000Z",
      updatedAt: "2026-02-08T12:10:00.000Z",
      error: "model timeout",
    });

    expect(parsed.error).toBe("model timeout");
  });
});
