import { describe, expect, it, vi } from "vitest";
import type { ReceiptProcessJob } from "@openclaw/home-inventory-contracts";
import type { WorkerApiClient } from "../client/api-client.js";
import type { ReceiptProcessor } from "../processor/receipt-processor.js";
import { WorkerRunner } from "./worker-runner.js";

function createJob(): ReceiptProcessJob {
  return {
    jobId: "job_1",
    receiptUploadId: "receipt_1",
    householdId: "household_1",
    status: "processing",
    attempts: 1,
    createdAt: "2026-02-08T12:00:00.000Z",
    updatedAt: "2026-02-08T12:01:00.000Z",
  };
}

describe("WorkerRunner", () => {
  it("completes a claimed job", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createJob()),
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => ({ notes: "done" })),
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
    expect(client.completeJob).toHaveBeenCalledWith("job_1", "done");
    expect(client.failJob).not.toHaveBeenCalled();
  });

  it("fails the job when processor throws", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => createJob()),
      completeJob: vi.fn(async () => {}),
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
    expect(client.completeJob).not.toHaveBeenCalled();
  });

  it("returns false when no job is available", async () => {
    const client: WorkerApiClient = {
      claimJob: vi.fn(async () => null),
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    };

    const processor: ReceiptProcessor = {
      process: vi.fn(async () => ({ notes: "unused" })),
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
});
