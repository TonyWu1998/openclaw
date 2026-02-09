import type { ReceiptItem } from "@openclaw/home-inventory-contracts";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config/env.js";
import { createApp } from "./app.js";
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

    const enqueueResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_main",
          ocrText: "Jasmine Rice 2kg\nTomato x4",
          receiptImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          merchantName: "Fresh Market",
          purchasedAt: "2026-02-08T12:00:00.000Z",
        }),
      },
    );

    expect(enqueueResponse.status).toBe(202);
    const enqueuePayload = (await enqueueResponse.json()) as {
      job: { jobId: string; status: string };
    };
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
      job: {
        job: { jobId: string; status: string };
        receipt: { ocrText?: string; receiptImageDataUrl?: string };
      } | null;
    };
    expect(claimPayload.job?.job.status).toBe("processing");
    expect(claimPayload.job?.receipt.ocrText).toContain("Jasmine Rice");
    expect(claimPayload.job?.receipt.receiptImageDataUrl?.startsWith("data:image/")).toBe(true);

    const resultResponse = await fetch(
      `${baseUrl}/internal/jobs/${enqueuePayload.job.jobId}/result`,
      {
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
      },
    );

    expect(resultResponse.status).toBe(200);

    const duplicateResultResponse = await fetch(
      `${baseUrl}/internal/jobs/${enqueuePayload.job.jobId}/result`,
      {
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
      },
    );

    expect(duplicateResultResponse.status).toBe(200);

    const statusResponse = await fetch(`${baseUrl}/v1/jobs/${enqueuePayload.job.jobId}`);
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as {
      job: { status: string; notes?: string };
    };
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

    const reviewResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/review`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_main",
          mode: "append",
          idempotencyKey: "review-main-1",
          items: [
            {
              itemKey: "egg",
              rawName: "Eggs",
              normalizedName: "egg",
              quantity: 6,
              unit: "count",
              category: "protein",
              confidence: 0.88,
            },
          ],
        }),
      },
    );
    expect(reviewResponse.status).toBe(200);

    const manualResponse = await fetch(`${baseUrl}/v1/inventory/household_main/manual-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "manual-main-1",
        items: [
          {
            itemKey: "paper-towel",
            rawName: "Paper Towel",
            normalizedName: "paper towel",
            quantity: 2,
            unit: "count",
            category: "household",
            confidence: 1,
          },
        ],
        notes: "manual add",
      }),
    });
    expect(manualResponse.status).toBe(201);

    const inventoryResponse = await fetch(`${baseUrl}/v1/inventory/household_main`);
    expect(inventoryResponse.status).toBe(200);
    const inventoryPayload = (await inventoryResponse.json()) as {
      householdId: string;
      lots: Array<{ itemKey: string; quantityRemaining: number }>;
      events: Array<{ eventType: string; source: string }>;
    };

    expect(inventoryPayload.householdId).toBe("household_main");
    expect(inventoryPayload.lots).toHaveLength(4);
    expect(
      inventoryPayload.lots.find((lot) => lot.itemKey === "jasmine-rice")?.quantityRemaining,
    ).toBe(2);
    expect(inventoryPayload.events).toHaveLength(4);
    expect(inventoryPayload.events.filter((event) => event.eventType === "add")).toHaveLength(4);
    expect(inventoryPayload.events.some((event) => event.source === "receipt_review")).toBe(true);
    expect(inventoryPayload.events.some((event) => event.source === "manual")).toBe(true);

    const dailyGenerateResponse = await fetch(
      `${baseUrl}/v1/recommendations/household_main/daily/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-02-09" }),
      },
    );

    expect(dailyGenerateResponse.status).toBe(200);
    const dailyPayload = (await dailyGenerateResponse.json()) as {
      run: { runType: string; model: string };
      recommendations: Array<{ recommendationId: string; itemKeys: string[] }>;
    };
    expect(dailyPayload.run.runType).toBe("daily");
    expect(dailyPayload.recommendations.length).toBeGreaterThan(0);
    const recommendationId = dailyPayload.recommendations[0]?.recommendationId;
    expect(recommendationId).toBeDefined();

    const feedbackResponse = await fetch(
      `${baseUrl}/v1/recommendations/${recommendationId}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_main",
          signalType: "accepted",
          signalValue: 1,
          context: "will cook this tomorrow",
        }),
      },
    );

    expect(feedbackResponse.status).toBe(200);

    const weeklyGenerateResponse = await fetch(
      `${baseUrl}/v1/recommendations/household_main/weekly/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOf: "2026-02-09" }),
      },
    );

    expect(weeklyGenerateResponse.status).toBe(200);
    const weeklyPayload = (await weeklyGenerateResponse.json()) as {
      run: { runType: string };
      recommendations: Array<{ itemKey: string }>;
    };
    expect(weeklyPayload.run.runType).toBe("weekly");
  });

  it("keeps review and manual entry idempotent when idempotency key is reused", async () => {
    const { baseUrl } = await startTestServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_idempotency",
        filename: "receipt-idempotent.jpg",
        contentType: "image/jpeg",
      }),
    });
    const uploadPayload = (await uploadResponse.json()) as { receiptUploadId: string };

    const enqueueResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_idempotency",
          ocrText: "Milk 1L",
        }),
      },
    );
    const enqueuePayload = (await enqueueResponse.json()) as { job: { jobId: string } };

    await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({}),
    });

    await fetch(`${baseUrl}/internal/jobs/${enqueuePayload.job.jobId}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({
        items: [
          {
            itemKey: "milk",
            rawName: "Whole Milk",
            normalizedName: "whole milk",
            quantity: 1,
            unit: "l",
            category: "dairy",
            confidence: 0.9,
          },
        ],
      }),
    });

    const reviewBody = JSON.stringify({
      householdId: "household_idempotency",
      mode: "overwrite",
      idempotencyKey: "review-repeat-1",
      items: [
        {
          itemKey: "milk",
          rawName: "Whole Milk",
          normalizedName: "whole milk",
          quantity: 2,
          unit: "l",
          category: "dairy",
          confidence: 0.9,
        },
      ],
    });

    const reviewOne = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/review`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: reviewBody,
      },
    );
    const reviewPayloadOne = (await reviewOne.json()) as {
      eventsCreated: number;
      applied: boolean;
    };
    expect(reviewPayloadOne.applied).toBe(true);
    expect(reviewPayloadOne.eventsCreated).toBe(1);

    const reviewTwo = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/review`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: reviewBody,
      },
    );
    const reviewPayloadTwo = (await reviewTwo.json()) as {
      eventsCreated: number;
      applied: boolean;
    };
    expect(reviewPayloadTwo.applied).toBe(false);
    expect(reviewPayloadTwo.eventsCreated).toBe(0);

    const manualBody = JSON.stringify({
      idempotencyKey: "manual-repeat-1",
      items: [
        {
          itemKey: "dish-soap",
          rawName: "Dish Soap",
          normalizedName: "dish soap",
          quantity: 1,
          unit: "bottle",
          category: "household",
          confidence: 1,
        },
      ],
    });

    const manualOne = await fetch(`${baseUrl}/v1/inventory/household_idempotency/manual-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: manualBody,
    });
    const manualPayloadOne = (await manualOne.json()) as {
      applied: boolean;
      eventsCreated: number;
    };
    expect(manualPayloadOne.applied).toBe(true);
    expect(manualPayloadOne.eventsCreated).toBe(1);

    const manualTwo = await fetch(`${baseUrl}/v1/inventory/household_idempotency/manual-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: manualBody,
    });
    const manualPayloadTwo = (await manualTwo.json()) as {
      applied: boolean;
      eventsCreated: number;
    };
    expect(manualPayloadTwo.applied).toBe(false);
    expect(manualPayloadTwo.eventsCreated).toBe(0);
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
