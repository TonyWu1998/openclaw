import type { ClaimedJob, JobResultRequest } from "@openclaw/home-inventory-contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkerApiClient } from "../client/api-client.js";
import type { ReceiptProcessor } from "../processor/receipt-processor.js";
import { WorkerRunner } from "./worker-runner.js";

function createClaimedJob(): ClaimedJob {
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
      ocrText: "Rice 2kg",
    },
  };
}

function createResult(): JobResultRequest {
  return {
    ocrText: "Rice 2kg",
    items: [
      {
        itemKey: "rice",
        rawName: "Rice 2kg",
        normalizedName: "rice",
        quantity: 2,
        unit: "kg",
        category: "grain",
        confidence: 0.9,
      },
    ],
    notes: "done",
  };
}

describe("WorkerRunner", () => {
  it("submits processed results for claimed jobs", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createClaimedJob()),
      submitJobResult: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => createResult()),
    };

    const runner = new WorkerRunner({
      client,
      processor,
      pollIntervalMs: 1,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const handled = await runner.runOnce();

    expect(handled).toBe(true);
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(client.submitJobResult).toHaveBeenCalledWith("job_1", createResult());
    expect(client.failJob).not.toHaveBeenCalled();
  });

  it("fails job when processor throws", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createClaimedJob()),
      submitJobResult: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => {
        throw new Error("extraction timeout");
      }),
    };

    const runner = new WorkerRunner({
      client,
      processor,
      pollIntervalMs: 1,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const handled = await runner.runOnce();

    expect(handled).toBe(true);
    expect(client.failJob).toHaveBeenCalledWith("job_1", "extraction timeout");
    expect(client.submitJobResult).not.toHaveBeenCalled();
  });

  it("returns false when no job is available", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => null),
      submitJobResult: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => createResult()),
    };

    const runner = new WorkerRunner({
      client,
      processor,
      pollIntervalMs: 1,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const handled = await runner.runOnce();

    expect(handled).toBe(false);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it("retries submit failures before succeeding", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createClaimedJob()),
      submitJobResult: vi
        .fn()
        .mockRejectedValueOnce(new Error("submit timeout"))
        .mockRejectedValueOnce(new Error("submit timeout"))
        .mockResolvedValue(undefined),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => createResult()),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = new WorkerRunner({
      client,
      processor,
      maxSubmitAttempts: 3,
      submitRetryBaseMs: 0,
      logger,
    });

    const handled = await runner.runOnce();

    expect(handled).toBe(true);
    expect(client.submitJobResult).toHaveBeenCalledTimes(3);
    expect(client.failJob).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("logs report failure when failJob call itself errors", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createClaimedJob()),
      submitJobResult: vi.fn(async () => {
        throw new Error("submit unavailable");
      }),
      failJob: vi.fn(async () => {
        throw new Error("fail endpoint unavailable");
      }),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => createResult()),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = new WorkerRunner({
      client,
      processor,
      maxSubmitAttempts: 1,
      submitRetryBaseMs: 0,
      logger,
    });

    const handled = await runner.runOnce();

    expect(handled).toBe(true);
    expect(client.submitJobResult).toHaveBeenCalledTimes(1);
    expect(client.failJob).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
