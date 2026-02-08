import { HttpWorkerApiClient } from "./client/api-client.js";
import { NoopReceiptProcessor } from "./processor/receipt-processor.js";
import { WorkerRunner } from "./runner/worker-runner.js";

function readEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiBaseUrl: env.HOME_INVENTORY_API_BASE_URL ?? "http://127.0.0.1:8789",
    workerToken: env.HOME_INVENTORY_WORKER_TOKEN ?? "phase1-worker-token",
    pollIntervalMs: Number.parseInt(env.HOME_INVENTORY_WORKER_POLL_INTERVAL_MS ?? "3000", 10),
  };
}

async function main() {
  const env = readEnv();
  const client = new HttpWorkerApiClient({
    baseUrl: env.apiBaseUrl,
    workerToken: env.workerToken,
  });

  const runner = new WorkerRunner({
    client,
    processor: new NoopReceiptProcessor(),
    pollIntervalMs: Number.isFinite(env.pollIntervalMs) ? env.pollIntervalMs : 3000,
  });

  const controller = new AbortController();
  const signal = controller.signal;

  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runner.runUntil(signal);
}

void main();
