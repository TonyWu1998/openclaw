import type { ReceiptProcessJob } from "@openclaw/home-inventory-contracts";

export type ReceiptProcessor = {
  process: (job: ReceiptProcessJob) => Promise<{ notes?: string }>;
};

export class NoopReceiptProcessor implements ReceiptProcessor {
  async process(job: ReceiptProcessJob): Promise<{ notes?: string }> {
    return {
      notes: `Phase 1 noop processor handled receipt ${job.receiptUploadId}`,
    };
  }
}
