import type { AddressInfo } from "node:net";
import {
  EnqueueJobResponseSchema,
  InventorySnapshotResponseSchema,
  JobStatusResponseSchema,
  ReceiptUploadResponseSchema,
} from "@openclaw/home-inventory-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "../../../home-inventory-api/src/config/env.js";
import { createApp } from "../../../home-inventory-api/src/app.js";
import { InMemoryJobStore } from "../../../home-inventory-api/src/storage/in-memory-job-store.js";
import { HttpWorkerApiClient } from "../client/api-client.js";
import {
  createReceiptProcessorFromEnv,
  type ReceiptProcessor,
} from "../processor/receipt-processor.js";
import { WorkerRunner } from "./worker-runner.js";

type RunningServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const servers: RunningServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

async function startServer(config?: Partial<ApiConfig>): Promise<RunningServer> {
  const mergedConfig: ApiConfig = {
    port: 0,
    workerToken: config?.workerToken ?? "test-worker-token",
    uploadOrigin: config?.uploadOrigin ?? "https://uploads.test.local",
  };

  const app = createApp({
    config: mergedConfig,
    store: new InMemoryJobStore({
      uploadOrigin: mergedConfig.uploadOrigin,
      maxJobAttempts: 2,
    }),
  });

  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

  const address = listener.address() as AddressInfo;
  const running: RunningServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };

  servers.push(running);
  return running;
}

describe("WorkerRunner reliability", () => {
  it("recovers queued job processing after a worker restart", async () => {
    const { baseUrl } = await startServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_restart",
        filename: "restart-receipt.jpg",
        contentType: "image/jpeg",
      }),
    });

    const uploadPayload = ReceiptUploadResponseSchema.parse(await uploadResponse.json());

    const enqueueResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_restart",
          ocrText: "Milk 1L\\nTomato x2",
          merchantName: "Restart Market",
          purchasedAt: "2026-02-08T12:00:00.000Z",
        }),
      },
    );

    const enqueuePayload = EnqueueJobResponseSchema.parse(await enqueueResponse.json());
    const jobId = enqueuePayload.job.jobId;

    const client = new HttpWorkerApiClient({
      baseUrl,
      workerToken: "test-worker-token",
    });

    const failingProcessor: ReceiptProcessor = {
      process: vi.fn(async () => {
        throw new Error("temporary extractor failure");
      }),
    };

    const runner1 = new WorkerRunner({
      client,
      processor: failingProcessor,
      maxSubmitAttempts: 1,
      submitRetryBaseMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const firstRunHandled = await runner1.runOnce();
    expect(firstRunHandled).toBe(true);

    const statusAfterFailureResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}`);
    const statusAfterFailure = JobStatusResponseSchema.parse(
      await statusAfterFailureResponse.json(),
    );
    expect(statusAfterFailure.job.status).toBe("queued");
    expect(statusAfterFailure.job.attempts).toBe(1);

    const restartProcessor = createReceiptProcessorFromEnv({} as NodeJS.ProcessEnv);
    const runner2 = new WorkerRunner({
      client,
      processor: restartProcessor,
      maxSubmitAttempts: 1,
      submitRetryBaseMs: 0,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const secondRunHandled = await runner2.runOnce();
    expect(secondRunHandled).toBe(true);

    const statusAfterRestartResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}`);
    const statusAfterRestart = JobStatusResponseSchema.parse(
      await statusAfterRestartResponse.json(),
    );
    expect(statusAfterRestart.job.status).toBe("completed");
    expect(statusAfterRestart.job.attempts).toBe(2);

    const inventoryResponse = await fetch(`${baseUrl}/v1/inventory/household_restart`);
    const inventory = InventorySnapshotResponseSchema.parse(await inventoryResponse.json());
    expect(inventory.lots.length).toBeGreaterThan(0);
    expect(inventory.events.length).toBeGreaterThan(0);
  });
});
