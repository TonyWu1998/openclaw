import {
  JobResultRequestSchema,
  type ClaimedJob,
  type JobResultRequest,
} from "@openclaw/home-inventory-contracts";
import { HeuristicReceiptExtractor } from "./heuristic-extractor.js";
import { normalizeDraftItems } from "./normalization.js";
import { OpenAiReceiptExtractor } from "./openai-extractor.js";
import type { ReceiptExtractor } from "./types.js";

export type ReceiptProcessor = {
  process: (claimedJob: ClaimedJob) => Promise<JobResultRequest>;
};

type ReceiptProcessorOptions = {
  primaryExtractor: ReceiptExtractor;
  fallbackExtractor: ReceiptExtractor;
};

export class PhaseTwoReceiptProcessor implements ReceiptProcessor {
  private readonly primaryExtractor: ReceiptExtractor;
  private readonly fallbackExtractor: ReceiptExtractor;

  constructor(options: ReceiptProcessorOptions) {
    this.primaryExtractor = options.primaryExtractor;
    this.fallbackExtractor = options.fallbackExtractor;
  }

  async process(claimedJob: ClaimedJob): Promise<JobResultRequest> {
    const ocrText = claimedJob.receipt.ocrText?.trim() ?? "";
    if (ocrText.length === 0) {
      throw new Error(`receipt ${claimedJob.receipt.receiptUploadId} has no OCR text`);
    }

    const extractionInput = {
      ocrText,
      merchantName: claimedJob.receipt.merchantName,
    };

    let drafts;
    try {
      drafts = await this.primaryExtractor.extract(extractionInput);
      if (drafts.length === 0) {
        drafts = await this.fallbackExtractor.extract(extractionInput);
      }
    } catch {
      drafts = await this.fallbackExtractor.extract(extractionInput);
    }

    const normalizedItems = normalizeDraftItems(drafts);
    if (normalizedItems.length === 0) {
      throw new Error(`no items extracted for receipt ${claimedJob.receipt.receiptUploadId}`);
    }

    return JobResultRequestSchema.parse({
      merchantName: claimedJob.receipt.merchantName,
      purchasedAt: claimedJob.receipt.purchasedAt,
      ocrText,
      items: normalizedItems,
      notes: `phase2 extracted ${normalizedItems.length} normalized receipt items`,
    });
  }
}

export function createReceiptProcessorFromEnv(env: NodeJS.ProcessEnv = process.env): ReceiptProcessor {
  const fallbackExtractor = new HeuristicReceiptExtractor();
  const openAiKey = env.OPENAI_API_KEY?.trim();

  if (!openAiKey) {
    return new PhaseTwoReceiptProcessor({
      primaryExtractor: fallbackExtractor,
      fallbackExtractor,
    });
  }

  const model = env.HOME_INVENTORY_OPENAI_MODEL?.trim() || "gpt-5.2-mini";
  const baseUrl = env.HOME_INVENTORY_OPENAI_BASE_URL?.trim();

  return new PhaseTwoReceiptProcessor({
    primaryExtractor: new OpenAiReceiptExtractor({
      apiKey: openAiKey,
      model,
      baseUrl,
    }),
    fallbackExtractor,
  });
}
