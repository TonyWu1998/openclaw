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

    const manualLot = inventoryPayload.lots.find((lot) => lot.itemKey === "paper-towel");
    expect(manualLot).toBeDefined();

    const overrideResponse = await fetch(
      `${baseUrl}/v1/inventory/household_main/lots/${manualLot?.lotId}/expiry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_main",
          expiresAt: "2026-12-31T00:00:00.000Z",
        }),
      },
    );
    expect(overrideResponse.status).toBe(200);
    const overridePayload = (await overrideResponse.json()) as {
      lot: { expirySource?: string; expiresAt?: string };
    };
    expect(overridePayload.lot.expirySource).toBe("exact");
    expect(overridePayload.lot.expiresAt).toBe("2026-12-31T00:00:00.000Z");

    const expiryRiskResponse = await fetch(`${baseUrl}/v1/inventory/household_main/expiry-risk`);
    expect(expiryRiskResponse.status).toBe(200);
    const expiryRiskPayload = (await expiryRiskResponse.json()) as {
      householdId: string;
      items: Array<{ riskLevel: string }>;
    };
    expect(expiryRiskPayload.householdId).toBe("household_main");
    expect(expiryRiskPayload.items.length).toBeGreaterThan(0);
    expect(
      expiryRiskPayload.items.every((item) =>
        ["critical", "high", "medium", "low"].includes(item.riskLevel),
      ),
    ).toBe(true);

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

    const pendingCheckinsResponse = await fetch(`${baseUrl}/v1/checkins/household_main/pending`);
    expect(pendingCheckinsResponse.status).toBe(200);
    const pendingCheckinsPayload = (await pendingCheckinsResponse.json()) as {
      checkins: Array<{ checkinId: string }>;
    };
    const checkinId = pendingCheckinsPayload.checkins[0]?.checkinId;
    expect(checkinId).toBeDefined();

    const submitCheckinResponse = await fetch(`${baseUrl}/v1/checkins/${checkinId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_main",
        outcome: "made",
        lines: [
          {
            itemKey: "tomato",
            unit: "count",
            quantityConsumed: 2,
          },
        ],
      }),
    });
    expect(submitCheckinResponse.status).toBe(200);
    const submitCheckinPayload = (await submitCheckinResponse.json()) as {
      checkin: { status: string };
      eventsCreated: number;
    };
    expect(submitCheckinPayload.checkin.status).toBe("completed");
    expect(submitCheckinPayload.eventsCreated).toBeGreaterThan(0);

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

  it("supports batch receipt enqueue with per-item errors and idempotent retries", async () => {
    const { baseUrl } = await startTestServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_batch_api",
        filename: "batch-api.jpg",
        contentType: "image/jpeg",
      }),
    });
    const uploadPayload = (await uploadResponse.json()) as { receiptUploadId: string };

    const batchOneResponse = await fetch(`${baseUrl}/v1/receipts/batch/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receipts: [
          {
            receiptUploadId: uploadPayload.receiptUploadId,
            householdId: "household_batch_api",
            ocrText: "Apple x4",
            idempotencyKey: "batch-api-key-1",
          },
          {
            receiptUploadId: "receipt_missing",
            householdId: "household_batch_api",
            ocrText: "Milk 1L",
          },
        ],
      }),
    });
    expect(batchOneResponse.status).toBe(202);
    const batchOnePayload = (await batchOneResponse.json()) as {
      accepted: number;
      rejected: number;
      results: Array<{ accepted: boolean; job?: { jobId: string } }>;
    };
    expect(batchOnePayload.accepted).toBe(1);
    expect(batchOnePayload.rejected).toBe(1);

    const firstJobId = batchOnePayload.results.find((result) => result.accepted)?.job?.jobId;
    expect(firstJobId).toBeDefined();

    const batchTwoResponse = await fetch(`${baseUrl}/v1/receipts/batch/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receipts: [
          {
            receiptUploadId: uploadPayload.receiptUploadId,
            householdId: "household_batch_api",
            ocrText: "Apple x4",
            idempotencyKey: "batch-api-key-1",
          },
        ],
      }),
    });
    expect(batchTwoResponse.status).toBe(202);
    const batchTwoPayload = (await batchTwoResponse.json()) as {
      accepted: number;
      results: Array<{ job?: { jobId: string } }>;
    };
    expect(batchTwoPayload.accepted).toBe(1);
    expect(batchTwoPayload.results[0]?.job?.jobId).toBe(firstJobId);

    const claimOne = await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({}),
    });
    const claimOnePayload = (await claimOne.json()) as {
      job: { job?: { jobId: string } } | null;
    };
    expect(claimOnePayload.job?.job?.jobId).toBe(firstJobId);

    const claimTwo = await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({}),
    });
    const claimTwoPayload = (await claimTwo.json()) as { job: null | object };
    expect(claimTwoPayload.job).toBeNull();
  });

  it("generates shopping drafts with price intelligence and supports patch/finalize workflow", async () => {
    const { baseUrl } = await startTestServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_shopping",
        filename: "shopping-1.jpg",
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
          householdId: "household_shopping",
          ocrText: "Milk 2L",
          purchasedAt: "2026-02-08T12:00:00.000Z",
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
        purchasedAt: "2026-02-08T12:00:00.000Z",
        items: [
          {
            itemKey: "milk",
            rawName: "Whole Milk",
            normalizedName: "whole milk",
            quantity: 0.2,
            unit: "l",
            category: "dairy",
            confidence: 0.9,
            unitPrice: 2.75,
          },
        ],
      }),
    });

    await fetch(`${baseUrl}/v1/recommendations/household_shopping/weekly/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekOf: "2026-02-09" }),
    });

    const generatedResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/household_shopping/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOf: "2026-02-09" }),
      },
    );
    expect(generatedResponse.status).toBe(201);
    const generatedPayload = (await generatedResponse.json()) as {
      draft: {
        draftId: string;
        items: Array<{ draftItemId: string; quantity: number; priceAlert: boolean }>;
      };
    };
    expect(generatedPayload.draft.items.length).toBeGreaterThan(0);
    expect(generatedPayload.draft.items.some((item) => typeof item.priceAlert === "boolean")).toBe(
      true,
    );

    const firstItem = generatedPayload.draft.items[0];
    expect(firstItem).toBeDefined();
    if (!firstItem) {
      throw new Error("expected shopping draft item");
    }

    const patchOne = await fetch(
      `${baseUrl}/v1/shopping-drafts/${generatedPayload.draft.draftId}/items`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_shopping",
          idempotencyKey: "shopping-patch-1",
          items: [
            {
              draftItemId: firstItem.draftItemId,
              quantity: firstItem.quantity + 1,
              notes: "buy extra",
            },
          ],
        }),
      },
    );
    expect(patchOne.status).toBe(200);
    const patchOnePayload = (await patchOne.json()) as { updated?: boolean };
    expect(patchOnePayload.updated).toBe(true);

    const patchTwo = await fetch(
      `${baseUrl}/v1/shopping-drafts/${generatedPayload.draft.draftId}/items`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_shopping",
          idempotencyKey: "shopping-patch-1",
          items: [
            {
              draftItemId: firstItem.draftItemId,
              quantity: firstItem.quantity + 1,
            },
          ],
        }),
      },
    );
    expect(patchTwo.status).toBe(200);
    const patchTwoPayload = (await patchTwo.json()) as { updated?: boolean };
    expect(patchTwoPayload.updated).toBe(false);

    const finalizeResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/${generatedPayload.draft.draftId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    );
    expect(finalizeResponse.status).toBe(200);
    const finalizePayload = (await finalizeResponse.json()) as {
      draft: { status: string };
      updated?: boolean;
    };
    expect(finalizePayload.draft.status).toBe("finalized");
    expect(finalizePayload.updated).toBe(true);

    const latestResponse = await fetch(`${baseUrl}/v1/shopping-drafts/household_shopping/latest`);
    expect(latestResponse.status).toBe(200);
    const latestPayload = (await latestResponse.json()) as { draft: { status: string } };
    expect(latestPayload.draft.status).toBe("finalized");

    const healthLatestResponse = await fetch(
      `${baseUrl}/v1/pantry-health/household_shopping?refresh=1`,
    );
    expect(healthLatestResponse.status).toBe(200);
    const healthLatestPayload = (await healthLatestResponse.json()) as {
      score: number;
      subscores: Record<string, number>;
    };
    expect(healthLatestPayload.score).toBeGreaterThanOrEqual(0);
    expect(healthLatestPayload.score).toBeLessThanOrEqual(100);
    expect(Object.keys(healthLatestPayload.subscores)).toHaveLength(5);

    const healthHistoryResponse = await fetch(
      `${baseUrl}/v1/pantry-health/household_shopping/history`,
    );
    expect(healthHistoryResponse.status).toBe(200);
    const healthHistoryPayload = (await healthHistoryResponse.json()) as {
      history: Array<{ score: number }>;
    };
    expect(healthHistoryPayload.history.length).toBeGreaterThan(0);
  });

  it("returns 404 when overriding expiry on unknown lot", async () => {
    const { baseUrl } = await startTestServer();

    const response = await fetch(`${baseUrl}/v1/inventory/household_main/lots/lot_missing/expiry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_main",
        expiresAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(404);
  });

  it("marks made checkin without quantity lines as needs_adjustment", async () => {
    const { baseUrl } = await startTestServer();

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_checkin_adjust",
        filename: "checkin-adjust.jpg",
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
          householdId: "household_checkin_adjust",
          ocrText: "Tomato x3",
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
            itemKey: "tomato",
            rawName: "Tomato",
            normalizedName: "tomato",
            quantity: 3,
            unit: "count",
            category: "produce",
            confidence: 0.8,
          },
        ],
      }),
    });

    await fetch(`${baseUrl}/v1/recommendations/household_checkin_adjust/daily/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-02-10" }),
    });

    const pendingResponse = await fetch(`${baseUrl}/v1/checkins/household_checkin_adjust/pending`);
    const pendingPayload = (await pendingResponse.json()) as {
      checkins: Array<{ checkinId: string }>;
    };
    const checkinId = pendingPayload.checkins[0]?.checkinId;
    expect(checkinId).toBeDefined();

    const submitResponse = await fetch(`${baseUrl}/v1/checkins/${checkinId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_checkin_adjust",
        outcome: "made",
      }),
    });
    expect(submitResponse.status).toBe(200);
    const submitPayload = (await submitResponse.json()) as {
      checkin: { status: string };
      eventsCreated: number;
    };
    expect(submitPayload.checkin.status).toBe("needs_adjustment");
    expect(submitPayload.eventsCreated).toBe(0);
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
