import type { AddressInfo } from "node:net";
import {
  DailyRecommendationsResponseSchema,
  EnqueueJobResponseSchema,
  InventorySnapshotResponseSchema,
  JobStatusResponseSchema,
  RecommendationFeedbackResponseSchema,
  ReceiptDetailsResponseSchema,
  ReceiptUploadResponseSchema,
  WeeklyRecommendationsResponseSchema,
} from "@openclaw/home-inventory-contracts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../../../home-inventory-api/src/config/env.js";
import { createApp } from "../../../home-inventory-api/src/app.js";
import { createRecommendationPlannerFromEnv } from "../../../home-inventory-api/src/domain/recommendation-planner.js";
import { InMemoryJobStore } from "../../../home-inventory-api/src/storage/in-memory-job-store.js";
import { HttpWorkerApiClient } from "../client/api-client.js";
import { createReceiptProcessorFromEnv } from "../processor/receipt-processor.js";
import { WorkerRunner } from "./worker-runner.js";

const LIVE_LMSTUDIO_E2E = process.env.HOME_INVENTORY_LIVE_LMSTUDIO === "1";
const LIVE_MODEL = process.env.HOME_INVENTORY_LIVE_LMSTUDIO_MODEL?.trim() || "qwen/qwen3-vl-30b";
const LIVE_BASE_URL =
  process.env.HOME_INVENTORY_LIVE_LMSTUDIO_BASE_URL?.trim() || "http://192.168.50.188:12345/v1";

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

function buildLlmEnv(): NodeJS.ProcessEnv {
  return {
    HOME_INVENTORY_LLM_PROVIDER: "lmstudio",
    HOME_INVENTORY_LLM_BASE_URL: LIVE_BASE_URL,
    HOME_INVENTORY_LLM_MODEL: LIVE_MODEL,
    HOME_INVENTORY_LLM_REQUEST_MODE: "chat_completions",
  };
}

function receiptImageDataUrl(): string {
  const iconPath = new URL(
    "../../../../assets/chrome-extension/icons/icon128.png",
    import.meta.url,
  );
  const imageBase64 = readFileSync(iconPath).toString("base64");
  return `data:image/png;base64,${imageBase64}`;
}

async function startServer(llmEnv: NodeJS.ProcessEnv): Promise<RunningServer> {
  const config: ApiConfig = {
    port: 0,
    workerToken: "test-worker-token",
    uploadOrigin: "https://uploads.test.local",
  };

  const app = createApp({
    config,
    store: new InMemoryJobStore({
      uploadOrigin: config.uploadOrigin,
      recommendationPlanner: createRecommendationPlannerFromEnv(llmEnv),
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

const describeLive = LIVE_LMSTUDIO_E2E ? describe : describe.skip;

describeLive("WorkerRunner live LM Studio E2E", () => {
  it("runs upload -> extract/persist -> recommendation generation -> inventory updates", async () => {
    const llmEnv = buildLlmEnv();
    const modelsResponse = await fetch(`${LIVE_BASE_URL.replace(/\/$/, "")}/models`);
    expect(modelsResponse.status).toBe(200);

    const { baseUrl } = await startServer(llmEnv);
    const client = new HttpWorkerApiClient({
      baseUrl,
      workerToken: "test-worker-token",
    });
    const processor = createReceiptProcessorFromEnv(llmEnv);
    const runner = new WorkerRunner({
      client,
      processor,
      maxSubmitAttempts: 1,
      submitRetryBaseMs: 0,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const imageDataUrl = receiptImageDataUrl();

    const upload1 = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_live_lmstudio",
        filename: "receipt-1.jpg",
        contentType: "image/jpeg",
      }),
    });
    const upload1Payload = ReceiptUploadResponseSchema.parse(await upload1.json());

    const enqueue1 = await fetch(
      `${baseUrl}/v1/receipts/${upload1Payload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_live_lmstudio",
          ocrText: "Egg x12\nTomato x6\nJasmine Rice 2kg",
          receiptImageDataUrl: imageDataUrl,
          merchantName: "Live LM Market",
          purchasedAt: "2026-02-09T10:00:00.000Z",
        }),
      },
    );
    const enqueue1Payload = EnqueueJobResponseSchema.parse(await enqueue1.json());

    const run1Handled = await runner.runOnce();
    expect(run1Handled).toBe(true);

    const job1Status = await fetch(`${baseUrl}/v1/jobs/${enqueue1Payload.job.jobId}`);
    const job1Payload = JobStatusResponseSchema.parse(await job1Status.json());
    expect(job1Payload.job.status).toBe("completed");

    const receipt1 = await fetch(`${baseUrl}/v1/receipts/${upload1Payload.receiptUploadId}`);
    const receipt1Payload = ReceiptDetailsResponseSchema.parse(await receipt1.json());
    expect(receipt1Payload.receipt.status).toBe("parsed");
    expect(receipt1Payload.receipt.items?.length).toBeGreaterThan(0);

    const inventory1 = await fetch(`${baseUrl}/v1/inventory/household_live_lmstudio`);
    const inventory1Payload = InventorySnapshotResponseSchema.parse(await inventory1.json());
    expect(inventory1Payload.lots.length).toBeGreaterThan(0);
    expect(inventory1Payload.events.length).toBeGreaterThan(0);
    const riceBefore =
      inventory1Payload.lots.find((lot) => lot.itemKey === "jasmine-rice")?.quantityRemaining ?? 0;
    const eventCountBefore = inventory1Payload.events.length;

    const upload2 = await fetch(`${baseUrl}/v1/receipts/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        householdId: "household_live_lmstudio",
        filename: "receipt-2.jpg",
        contentType: "image/jpeg",
      }),
    });
    const upload2Payload = ReceiptUploadResponseSchema.parse(await upload2.json());

    const enqueue2 = await fetch(
      `${baseUrl}/v1/receipts/${upload2Payload.receiptUploadId}/process`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_live_lmstudio",
          ocrText: "Jasmine Rice 1kg\nTomato x2",
          receiptImageDataUrl: imageDataUrl,
          merchantName: "Live LM Market",
          purchasedAt: "2026-02-10T10:00:00.000Z",
        }),
      },
    );
    const enqueue2Payload = EnqueueJobResponseSchema.parse(await enqueue2.json());

    const run2Handled = await runner.runOnce();
    expect(run2Handled).toBe(true);

    const job2Status = await fetch(`${baseUrl}/v1/jobs/${enqueue2Payload.job.jobId}`);
    const job2Payload = JobStatusResponseSchema.parse(await job2Status.json());
    expect(job2Payload.job.status).toBe("completed");

    const inventory2 = await fetch(`${baseUrl}/v1/inventory/household_live_lmstudio`);
    const inventory2Payload = InventorySnapshotResponseSchema.parse(await inventory2.json());
    const riceAfter =
      inventory2Payload.lots.find((lot) => lot.itemKey === "jasmine-rice")?.quantityRemaining ?? 0;
    expect(riceAfter).toBeGreaterThan(riceBefore);
    expect(inventory2Payload.events.length).toBeGreaterThan(eventCountBefore);

    const dailyGenerate = await fetch(
      `${baseUrl}/v1/recommendations/household_live_lmstudio/daily/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-02-11" }),
      },
    );
    const dailyPayload = DailyRecommendationsResponseSchema.parse(await dailyGenerate.json());
    expect(dailyPayload.run.model).toBe(LIVE_MODEL);
    expect(dailyPayload.recommendations.length).toBeGreaterThan(0);

    const firstRecommendationId = dailyPayload.recommendations[0]?.recommendationId;
    if (!firstRecommendationId) {
      throw new Error("missing daily recommendation ID");
    }

    const feedback = await fetch(
      `${baseUrl}/v1/recommendations/${firstRecommendationId}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId: "household_live_lmstudio",
          signalType: "accepted",
          signalValue: 1,
          context: "live-e2e validation",
        }),
      },
    );
    const feedbackPayload = RecommendationFeedbackResponseSchema.parse(await feedback.json());
    expect(feedbackPayload.feedback.signalType).toBe("accepted");

    const weeklyGenerate = await fetch(
      `${baseUrl}/v1/recommendations/household_live_lmstudio/weekly/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOf: "2026-02-11" }),
      },
    );
    const weeklyPayload = WeeklyRecommendationsResponseSchema.parse(await weeklyGenerate.json());
    expect(weeklyPayload.run.model).toBe(LIVE_MODEL);
    expect(weeklyPayload.recommendations.length).toBeGreaterThan(0);
  }, 240_000);
});
