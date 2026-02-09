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
  maxSubmitAttempts?: number;
  submitRetryBaseMs?: number;
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
  private readonly maxSubmitAttempts: number;
  private readonly submitRetryBaseMs: number;
  private readonly logger: WorkerRunnerLogger;

  constructor(options: WorkerRunnerOptions) {
    this.client = options.client;
    this.processor = options.processor;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.maxSubmitAttempts = Math.max(1, options.maxSubmitAttempts ?? 3);
    this.submitRetryBaseMs = Math.max(0, options.submitRetryBaseMs ?? 250);
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
      await this.submitResultWithRetries(claimed.job.jobId, result);
      this.logger.info(`[home-inventory-worker] completed ${claimed.job.jobId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.client.failJob(claimed.job.jobId, message);
      } catch (reportError) {
        const reportMessage =
          reportError instanceof Error ? reportError.message : String(reportError);
        this.logger.error(
          `[home-inventory-worker] failed to report ${claimed.job.jobId}: ${reportMessage}`,
        );
      }
      this.logger.error(`[home-inventory-worker] failed ${claimed.job.jobId}: ${message}`);
    }
  }

  private async submitResultWithRetries(
    jobId: string,
    result: Awaited<ReturnType<ReceiptProcessor["process"]>>,
  ): Promise<void> {
    let attempt = 1;
    while (attempt <= this.maxSubmitAttempts) {
      try {
        await this.client.submitJobResult(jobId, result);
        return;
      } catch (error) {
        if (attempt >= this.maxSubmitAttempts) {
          throw error;
        }

        const waitMs = this.submitRetryBaseMs * 2 ** (attempt - 1);
        this.logger.warn(
          `[home-inventory-worker] submit attempt ${attempt} failed for ${jobId}; retrying in ${waitMs}ms`,
        );
        await sleepNoSignal(waitMs);
        attempt += 1;
      }
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

async function sleepNoSignal(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
