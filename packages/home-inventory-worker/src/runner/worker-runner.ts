import type { ClaimedJob } from "@openclaw/home-inventory-contracts";
import type { WorkerApiClient } from "../client/api-client.js";
import type { ReceiptProcessor } from "../processor/receipt-processor.js";

export type WorkerRunnerLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type WorkerRunnerOptions = {
  client: WorkerApiClient;
  processor: ReceiptProcessor;
  pollIntervalMs?: number;
  logger?: WorkerRunnerLogger;
};

const defaultLogger: WorkerRunnerLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export class WorkerRunner {
  private readonly client: WorkerApiClient;
  private readonly processor: ReceiptProcessor;
  private readonly pollIntervalMs: number;
  private readonly logger: WorkerRunnerLogger;

  constructor(options: WorkerRunnerOptions) {
    this.client = options.client;
    this.processor = options.processor;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.logger = options.logger ?? defaultLogger;
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.client.claimJob();
    if (!claimed) {
      return false;
    }

    await this.processClaimedJob(claimed);
    return true;
  }

  async runUntil(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const handled = await this.runOnce();
      if (!handled) {
        await sleep(this.pollIntervalMs, signal).catch(() => {});
      }
    }
  }

  private async processClaimedJob(claimed: ClaimedJob): Promise<void> {
    try {
      this.logger.info(`[home-inventory-worker] processing ${claimed.job.jobId}`);
      const result = await this.processor.process(claimed);
      await this.client.submitJobResult(claimed.job.jobId, result);
      this.logger.info(`[home-inventory-worker] completed ${claimed.job.jobId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.client.failJob(claimed.job.jobId, message);
      this.logger.error(`[home-inventory-worker] failed ${claimed.job.jobId}: ${message}`);
    }
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
