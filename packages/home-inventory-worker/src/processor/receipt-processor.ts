import {
  JobResultRequestSchema,
  type ClaimedJob,
  type JobResultRequest,
} from "@openclaw/home-inventory-contracts";
import type { ReceiptExtractor } from "./types.js";
import { HeuristicReceiptExtractor } from "./heuristic-extractor.js";
import { normalizeDraftItems } from "./normalization.js";
import {
  OpenAiReceiptExtractor,
  type LlmRequestMode,
  type SupportedLlmProvider,
} from "./openai-extractor.js";

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
    const receiptImageDataUrl = claimedJob.receipt.receiptImageDataUrl?.trim();
    if (ocrText.length === 0 && !receiptImageDataUrl) {
      throw new Error(
        `receipt ${claimedJob.receipt.receiptUploadId} has neither OCR text nor image data`,
      );
    }

    const extractionInput = {
      ocrText,
      merchantName: claimedJob.receipt.merchantName,
      receiptImageDataUrl,
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
      ocrText: ocrText.length > 0 ? ocrText : undefined,
      items: normalizedItems,
      notes: `phase2 extracted ${normalizedItems.length} normalized receipt items`,
    });
  }
}

type ReceiptLlmConfig = {
  provider: SupportedLlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  requestMode: LlmRequestMode;
  extraHeaders: Record<string, string>;
};

const SUPPORTED_PROVIDERS: SupportedLlmProvider[] = [
  "openai",
  "openrouter",
  "gemini",
  "lmstudio",
  "openai-compatible",
];

export function createReceiptProcessorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReceiptProcessor {
  const fallbackExtractor = new HeuristicReceiptExtractor();
  const llmConfig = resolveReceiptLlmConfigFromEnv(env);

  if (!llmConfig) {
    return new PhaseTwoReceiptProcessor({
      primaryExtractor: fallbackExtractor,
      fallbackExtractor,
    });
  }

  return new PhaseTwoReceiptProcessor({
    primaryExtractor: new OpenAiReceiptExtractor({
      provider: llmConfig.provider,
      apiKey: llmConfig.apiKey,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      requestMode: llmConfig.requestMode,
      extraHeaders: llmConfig.extraHeaders,
    }),
    fallbackExtractor,
  });
}

export function resolveReceiptLlmConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReceiptLlmConfig | null {
  const provider = parseProvider(env.HOME_INVENTORY_LLM_PROVIDER);
  const apiKey = resolveProviderApiKey(provider, env);
  const requiresApiKey =
    provider === "openai" || provider === "openrouter" || provider === "gemini";
  if (requiresApiKey && !apiKey) {
    return null;
  }

  const model =
    env.HOME_INVENTORY_EXTRACTOR_MODEL?.trim() ||
    env.HOME_INVENTORY_LLM_MODEL?.trim() ||
    env.HOME_INVENTORY_OPENAI_MODEL?.trim() ||
    defaultModel(provider);

  const baseUrl =
    env.HOME_INVENTORY_EXTRACTOR_BASE_URL?.trim() ||
    env.HOME_INVENTORY_LLM_BASE_URL?.trim() ||
    env.HOME_INVENTORY_OPENAI_BASE_URL?.trim();

  const requestMode = resolveRequestMode(env.HOME_INVENTORY_LLM_REQUEST_MODE, provider);
  const extraHeaders = resolveProviderHeaders(provider, env);

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    requestMode,
    extraHeaders,
  };
}

function parseProvider(value: string | undefined): SupportedLlmProvider {
  const lowered = value?.trim().toLowerCase();
  if (!lowered) {
    return "openai";
  }

  const matched = SUPPORTED_PROVIDERS.find((provider) => provider === lowered);
  return matched ?? "openai";
}

function resolveRequestMode(
  value: string | undefined,
  provider: SupportedLlmProvider,
): LlmRequestMode {
  if (value === "responses" || value === "chat_completions") {
    return value;
  }

  switch (provider) {
    case "openrouter":
    case "gemini":
    case "lmstudio":
    case "openai-compatible":
      return "chat_completions";
    case "openai":
    default:
      return "responses";
  }
}

function resolveProviderApiKey(
  provider: SupportedLlmProvider,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicit = env.HOME_INVENTORY_LLM_API_KEY?.trim();
  if (explicit) {
    return explicit;
  }

  switch (provider) {
    case "openrouter":
      return env.OPENROUTER_API_KEY?.trim() || undefined;
    case "gemini":
      return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
    case "openai":
      return env.OPENAI_API_KEY?.trim() || undefined;
    case "lmstudio":
    case "openai-compatible":
      return undefined;
    default:
      return undefined;
  }
}

function resolveProviderHeaders(
  provider: SupportedLlmProvider,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (provider !== "openrouter") {
    return {};
  }

  const referer =
    env.HOME_INVENTORY_OPENROUTER_SITE_URL?.trim() || env.OPENROUTER_HTTP_REFERER?.trim();
  const appName = env.HOME_INVENTORY_OPENROUTER_APP_NAME?.trim() || env.OPENROUTER_APP_NAME?.trim();
  const headers: Record<string, string> = {};

  if (referer) {
    headers["HTTP-Referer"] = referer;
  }
  if (appName) {
    headers["X-Title"] = appName;
  }

  return headers;
}

function defaultModel(provider: SupportedLlmProvider): string {
  switch (provider) {
    case "gemini":
      return "gemini-2.5-flash";
    case "openrouter":
      return "openai/gpt-4o-mini";
    case "lmstudio":
    case "openai-compatible":
      return "local-model";
    case "openai":
    default:
      return "gpt-5.2-mini";
  }
}
