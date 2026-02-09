import type { JobResultRequest, ReceiptItem } from "@openclaw/home-inventory-contracts";
import type { AddressInfo } from "node:net";
import {
  BatchReceiptProcessResponseSchema,
  DailyRecommendationsResponseSchema,
  EnqueueJobResponseSchema,
  ExpiryRiskResponseSchema,
  HealthResponseSchema,
  InventorySnapshotResponseSchema,
  JobResultResponseSchema,
  JobStatusResponseSchema,
  LotExpiryOverrideResponseSchema,
  ManualInventoryEntryResponseSchema,
  MealCheckinPendingResponseSchema,
  MealCheckinSubmitResponseSchema,
  ReceiptDetailsResponseSchema,
  ReceiptReviewResponseSchema,
  ReceiptUploadResponseSchema,
  RecommendationFeedbackResponseSchema,
  ShoppingDraftResponseSchema,
  WeeklyRecommendationsResponseSchema,
} from "@openclaw/home-inventory-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { InMemoryJobStore } from "./storage/in-memory-job-store.js";

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
    store: new InMemoryJobStore({ uploadOrigin: mergedConfig.uploadOrigin }),
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

const EXTRACTED_ITEMS: ReceiptItem[] = [
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

describe("home inventory API public contracts", () => {
  it("validates each public endpoint payload against shared schemas", async () => {
    const { baseUrl } = await startServer();

    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthPayload = HealthResponseSchema.parse(await healthResponse.json());
    expect(healthPayload.ok).toBe(true);

    const uploadResponse = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_contract",
        filename: "contract-receipt.jpg",
        contentType: "image/jpeg",
      }),
    });

    const uploadPayload = ReceiptUploadResponseSchema.parse(await uploadResponse.json());
    expect(uploadResponse.status).toBe(201);

    const enqueueResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          ocrText: "Jasmine Rice 2kg\\nTomato x4",
          receiptImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          merchantName: "Contract Market",
          purchasedAt: "2026-02-08T12:00:00.000Z",
        }),
      },
    );

    const enqueuePayload = EnqueueJobResponseSchema.parse(await enqueueResponse.json());
    const jobId = enqueuePayload.job.jobId;
    expect(enqueueResponse.status).toBe(202);

    const queuedStatusResponse = await fetch(`${baseUrl}/v1/jobs/${jobId}`);
    const queuedStatus = JobStatusResponseSchema.parse(await queuedStatusResponse.json());
    expect(queuedStatus.job.status).toBe("queued");

    const claimResponse = await fetch(`${baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify({}),
    });

    expect(claimResponse.status).toBe(200);

    const jobResultPayload: JobResultRequest = {
      merchantName: "Contract Market",
      purchasedAt: "2026-02-08T12:00:00.000Z",
      ocrText: "Jasmine Rice 2kg\\nTomato x4",
      items: EXTRACTED_ITEMS,
      notes: "contract test result",
    };

    const resultResponse = await fetch(`${baseUrl}/internal/jobs/${jobId}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-home-inventory-worker-token": "test-worker-token",
      },
      body: JSON.stringify(jobResultPayload),
    });

    const resultPayload = JobResultResponseSchema.parse(await resultResponse.json());
    expect(resultPayload.job.status).toBe("completed");

    const receiptResponse = await fetch(`${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}`);
    const receiptPayload = ReceiptDetailsResponseSchema.parse(await receiptResponse.json());
    expect(receiptPayload.receipt.status).toBe("parsed");
    expect(receiptPayload.receipt.receiptImageDataUrl?.startsWith("data:image/")).toBe(true);

    const reviewResponse = await fetch(
      `${baseUrl}/v1/receipts/${uploadPayload.receiptUploadId}/review`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          mode: "append",
          idempotencyKey: "review-contract-1",
          items: [
            {
              itemKey: "egg",
              rawName: "Eggs",
              normalizedName: "egg",
              quantity: 6,
              unit: "count",
              category: "protein",
              confidence: 0.9,
            },
          ],
        }),
      },
    );
    const reviewPayload = ReceiptReviewResponseSchema.parse(await reviewResponse.json());
    expect(reviewPayload.applied).toBe(true);
    expect(reviewPayload.eventsCreated).toBeGreaterThan(0);

    const manualEntryResponse = await fetch(
      `${baseUrl}/v1/inventory/household_contract/manual-items`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "manual-contract-1",
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
          notes: "manual add",
        }),
      },
    );
    const manualPayload = ManualInventoryEntryResponseSchema.parse(
      await manualEntryResponse.json(),
    );
    expect(manualPayload.applied).toBe(true);

    const inventoryResponse = await fetch(`${baseUrl}/v1/inventory/household_contract`);
    const inventoryPayload = InventorySnapshotResponseSchema.parse(await inventoryResponse.json());
    expect(inventoryPayload.householdId).toBe("household_contract");
    expect(inventoryPayload.events.some((event) => event.source === "receipt_review")).toBe(true);
    expect(inventoryPayload.events.some((event) => event.source === "manual")).toBe(true);

    const dishSoapLot = inventoryPayload.lots.find((lot) => lot.itemKey === "dish-soap");
    expect(dishSoapLot).toBeDefined();

    const expiryOverrideResponse = await fetch(
      `${baseUrl}/v1/inventory/household_contract/lots/${dishSoapLot?.lotId}/expiry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          expiresAt: "2026-03-01T00:00:00.000Z",
          notes: "manual override",
        }),
      },
    );
    const expiryOverridePayload = LotExpiryOverrideResponseSchema.parse(
      await expiryOverrideResponse.json(),
    );
    expect(expiryOverridePayload.lot.expirySource).toBe("exact");

    const expiryRiskResponse = await fetch(
      `${baseUrl}/v1/inventory/household_contract/expiry-risk`,
    );
    const expiryRiskPayload = ExpiryRiskResponseSchema.parse(await expiryRiskResponse.json());
    expect(expiryRiskPayload.items.length).toBeGreaterThan(0);

    const dailyGenerateResponse = await fetch(
      `${baseUrl}/v1/recommendations/household_contract/daily/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-02-09" }),
      },
    );

    const dailyGenerated = DailyRecommendationsResponseSchema.parse(
      await dailyGenerateResponse.json(),
    );
    expect(dailyGenerated.recommendations.length).toBeGreaterThan(0);

    const pendingCheckinsResponse = await fetch(
      `${baseUrl}/v1/checkins/household_contract/pending`,
    );
    const pendingCheckins = MealCheckinPendingResponseSchema.parse(
      await pendingCheckinsResponse.json(),
    );
    expect(pendingCheckins.checkins.length).toBeGreaterThan(0);
    const firstCheckin = pendingCheckins.checkins[0];
    expect(firstCheckin).toBeDefined();

    const submitCheckinResponse = await fetch(
      `${baseUrl}/v1/checkins/${firstCheckin?.checkinId}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          outcome: "made",
          lines: [
            {
              itemKey: "tomato",
              unit: "count",
              quantityConsumed: 1,
            },
          ],
        }),
      },
    );
    const submittedCheckin = MealCheckinSubmitResponseSchema.parse(
      await submitCheckinResponse.json(),
    );
    expect(submittedCheckin.checkin.status).toBe("completed");

    const dailyReadResponse = await fetch(`${baseUrl}/v1/recommendations/household_contract/daily`);
    const dailyRead = DailyRecommendationsResponseSchema.parse(await dailyReadResponse.json());
    expect(dailyRead.run.runType).toBe("daily");

    const recommendationId = dailyRead.recommendations[0]?.recommendationId;
    expect(recommendationId).toBeDefined();

    const feedbackResponse = await fetch(
      `${baseUrl}/v1/recommendations/${recommendationId}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          signalType: "accepted",
        }),
      },
    );

    const feedbackPayload = RecommendationFeedbackResponseSchema.parse(
      await feedbackResponse.json(),
    );
    expect(feedbackPayload.feedback.signalType).toBe("accepted");

    const weeklyGenerateResponse = await fetch(
      `${baseUrl}/v1/recommendations/household_contract/weekly/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOf: "2026-02-09" }),
      },
    );

    const weeklyGenerated = WeeklyRecommendationsResponseSchema.parse(
      await weeklyGenerateResponse.json(),
    );
    expect(weeklyGenerated.run.runType).toBe("weekly");

    const shoppingDraftGenerateResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/household_contract/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOf: "2026-02-09" }),
      },
    );
    const shoppingDraftGenerated = ShoppingDraftResponseSchema.parse(
      await shoppingDraftGenerateResponse.json(),
    );
    expect(shoppingDraftGenerated.draft.items.length).toBe(weeklyGenerated.recommendations.length);
    expect(
      shoppingDraftGenerated.draft.items.every((item) => typeof item.priceAlert === "boolean"),
    ).toBe(true);

    const shoppingDraftLatestResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/household_contract/latest`,
    );
    const shoppingDraftLatest = ShoppingDraftResponseSchema.parse(
      await shoppingDraftLatestResponse.json(),
    );
    expect(shoppingDraftLatest.draft.draftId).toBe(shoppingDraftGenerated.draft.draftId);

    const firstDraftItem = shoppingDraftGenerated.draft.items[0];
    expect(firstDraftItem).toBeDefined();
    if (!firstDraftItem) {
      throw new Error("expected shopping draft item");
    }

    const shoppingDraftPatchedResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/${shoppingDraftGenerated.draft.draftId}/items`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_contract",
          idempotencyKey: "draft-contract-patch-1",
          items: [
            {
              draftItemId: firstDraftItem.draftItemId,
              quantity: firstDraftItem.quantity + 1,
              notes: "adjusted in contract test",
            },
          ],
        }),
      },
    );
    const shoppingDraftPatched = ShoppingDraftResponseSchema.parse(
      await shoppingDraftPatchedResponse.json(),
    );
    expect(shoppingDraftPatched.updated).toBe(true);

    const shoppingDraftFinalizedResponse = await fetch(
      `${baseUrl}/v1/shopping-drafts/${shoppingDraftGenerated.draft.draftId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    );
    const shoppingDraftFinalized = ShoppingDraftResponseSchema.parse(
      await shoppingDraftFinalizedResponse.json(),
    );
    expect(shoppingDraftFinalized.draft.status).toBe("finalized");

    const weeklyReadResponse = await fetch(
      `${baseUrl}/v1/recommendations/household_contract/weekly`,
    );
    const weeklyRead = WeeklyRecommendationsResponseSchema.parse(await weeklyReadResponse.json());
    expect(weeklyRead.run.runType).toBe("weekly");
  });

  it("validates batch receipt process endpoint contract with partial failures", async () => {
    const { baseUrl } = await startServer();

    const uploadOne = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_batch_contract",
        filename: "batch-contract-1.jpg",
        contentType: "image/jpeg",
      }),
    });
    const uploadOnePayload = ReceiptUploadResponseSchema.parse(await uploadOne.json());

    const uploadTwo = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_batch_contract",
        filename: "batch-contract-2.jpg",
        contentType: "image/jpeg",
      }),
    });
    const uploadTwoPayload = ReceiptUploadResponseSchema.parse(await uploadTwo.json());

    const batchResponse = await fetch(`${baseUrl}/v1/receipts/batch/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        receipts: [
          {
            receiptUploadId: uploadOnePayload.receiptUploadId,
            householdId: "household_batch_contract",
            ocrText: "Banana x6",
          },
          {
            receiptUploadId: "receipt_does_not_exist",
            householdId: "household_batch_contract",
            ocrText: "Yogurt x2",
          },
          {
            receiptUploadId: uploadTwoPayload.receiptUploadId,
            householdId: "household_batch_contract",
          },
        ],
      }),
    });

    expect(batchResponse.status).toBe(202);
    const batchPayload = BatchReceiptProcessResponseSchema.parse(await batchResponse.json());
    expect(batchPayload.requested).toBe(3);
    expect(batchPayload.accepted).toBe(1);
    expect(batchPayload.rejected).toBe(2);
    expect(batchPayload.results.filter((entry) => entry.accepted)).toHaveLength(1);
  });
});
