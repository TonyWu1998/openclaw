import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ReceiptItem } from "@openclaw/home-inventory-contracts";
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

function testItems(): ReceiptItem[] {
  return [
    {
      itemKey: "jasmine-rice",
      rawName: "Jasmine Rice 2kg",
      normalizedName: "jasmine rice",
      quantity: 2,
      unit: "kg",
      category: "grain",
      confidence: 0.94,
    },
    {
      itemKey: "tomato",
      rawName: "Tomato",
      normalizedName: "tomato",
      quantity: 4,
      unit: "count",
      category: "produce",
      confidence: 0.88,
    },
  ];
}

describe("home inventory api", () => {
  it("runs receipt ingestion lifecycle and applies inventory mutation events", async () => {
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
      body: JSON.stringify({
        householdId: "household_main",
        ocrText: "Jasmine Rice 2kg\nTomato x4",
        merchantName: "Fresh Market",
        purchasedAt: "2026-02-08T12:00:00.000Z",
      }),
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
    const claimPayload = (await claimResponse.json()) as {
      job: { job: { jobId: string; status: string }; receipt: { ocrText?: string } } | null;
    };
    expect(claimPayload.job?.job.status).toBe("processing");
    expect(claimPayload.job?.receipt.ocrText).toContain("Jasmine Rice");

    const resultResponse = await fetch(`${baseUrl}/internal/jobs/${enqueuePayload.job.jobId}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({
        merchantName: "Fresh Market",
        purchasedAt: "2026-02-08T12:00:00.000Z",
        ocrText: "Jasmine Rice 2kg\nTomato x4",
        items: testItems(),
        notes: "phase2 extractor complete",
      }),
    });

    expect(resultResponse.status).toBe(200);

    const statusResponse = await fetch(`${baseUrl}/v1/jobs/${enqueuePayload.job.jobId}`);
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as { job: { status: string; notes?: string } };
    expect(statusPayload.job.status).toBe("completed");
    expect(statusPayload.job.notes).toBe("phase2 extractor complete");

    const receiptResponse = await fetch(`${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}`);
    expect(receiptResponse.status).toBe(200);
    const receiptPayload = (await receiptResponse.json()) as {
      receipt: { status: string; items?: ReceiptItem[]; merchantName?: string };
    };
    expect(receiptPayload.receipt.status).toBe("parsed");
    expect(receiptPayload.receipt.items?.length).toBe(2);
    expect(receiptPayload.receipt.merchantName).toBe("Fresh Market");

    const inventoryResponse = await fetch(`${baseUrl}/v1/inventory/household_main`);
    expect(inventoryResponse.status).toBe(200);
    const inventoryPayload = (await inventoryResponse.json()) as {
      householdId: string;
      lots: Array<{ itemKey: string; quantityRemaining: number }>;
      events: Array<{ eventType: string }>;
    };

    expect(inventoryPayload.householdId).toBe("household_main");
    expect(inventoryPayload.lots).toHaveLength(2);
    expect(inventoryPayload.lots.find((lot) => lot.itemKey === "jasmine-rice")?.quantityRemaining).toBe(2);
    expect(inventoryPayload.events).toHaveLength(2);
    expect(inventoryPayload.events.every((event) => event.eventType === "add")).toBe(true);
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
