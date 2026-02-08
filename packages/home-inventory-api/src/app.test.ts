import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ApiConfig } from "./config/env.js";
import { InMemoryJobStore } from "./storage/in-memory-job-store.js";

type RunningTestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const servers: RunningTestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

async function startTestServer(config?: Partial<ApiConfig>): Promise<RunningTestServer> {
  const mergedConfig: ApiConfig = {
    port: 0,
    workerToken: config?.workerToken ?? "test-worker-token",
    uploadOrigin: config?.uploadOrigin ?? "https://uploads.test.local",
  };

  const app = createApp({
    config: mergedConfig,
    store: new InMemoryJobStore({ uploadOrigin: mergedConfig.uploadOrigin }),
  });

  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

  const address = listener.address() as AddressInfo;
  const running: RunningTestServer = {
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

describe("home inventory api", () => {
  it("runs receipt queue lifecycle through API and worker endpoints", async () => {
    const { baseUrl } = await startTestServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_main",
        filename: "receipt-1.jpg",
        contentType: "image/jpeg",
      }),
    });

    expect(uploadResponse.status).toBe(201);
    const uploadPayload = (await uploadResponse.json()) as { receiptUploadId: string };

    const enqueueResponse = await fetch(`${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId: "household_main" }),
    });

    expect(enqueueResponse.status).toBe(202);
    const enqueuePayload = (await enqueueResponse.json()) as { job: { jobId: string; status: string } };
    expect(enqueuePayload.job.status).toBe("queued");

    const claimResponse = await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({}),
    });

    expect(claimResponse.status).toBe(200);
    const claimPayload = (await claimResponse.json()) as { job: { jobId: string; status: string } | null };
    expect(claimPayload.job?.status).toBe("processing");

    const completeResponse = await fetch(`${baseUrl}/internal/jobs/${enqueuePayload.job.jobId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({ notes: "phase1 processor stub complete" }),
    });

    expect(completeResponse.status).toBe(200);

    const statusResponse = await fetch(`${baseUrl}/v1/jobs/${enqueuePayload.job.jobId}`);
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as { job: { status: string } };
    expect(statusPayload.job.status).toBe("completed");
  });

  it("rejects internal worker actions without correct token", async () => {
    const { baseUrl } = await startTestServer();

    const response = await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });
});
