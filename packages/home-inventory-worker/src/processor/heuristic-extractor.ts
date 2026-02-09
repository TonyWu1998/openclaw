import type { DraftReceiptItem, ReceiptExtractionInput, ReceiptExtractor } from "./types.js";

const LINE_REGEX =
  /^(?<name>[A-Za-z][A-Za-z0-9\s().,/+-]*?)(?:\s+(?<qty>\d+(?:\.\d+)?))?(?:\s*(?<unit>kg|g|lb|lbs|oz|ml|l|count|x|pack|box|bottle))?$/i;

export class HeuristicReceiptExtractor implements ReceiptExtractor {
  async extract(input: ReceiptExtractionInput): Promise<DraftReceiptItem[]> {
    const lines = input.ocrText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const results: DraftReceiptItem[] = [];

    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed) {
        results.push(parsed);
      }
    }

    if (results.length > 0) {
      return results;
    }

    return [
      {
        rawName: "unknown item",
        quantity: 1,
        unit: "count",
        confidence: 0.2,
      },
    ];
  }
}

function parseLine(line: string): DraftReceiptItem | null {
  const cleaned = line
    .replace(/[|*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }

  const match = cleaned.match(LINE_REGEX);
  if (!match?.groups) {
    return {
      rawName: cleaned,
      quantity: inferQuantityFallback(cleaned),
      unit: inferUnitFallback(cleaned),
      confidence: 0.45,
    };
  }

  const name = match.groups.name?.trim();
  if (!name) {
    return null;
  }

  const quantity = match.groups.qty
    ? Number.parseFloat(match.groups.qty)
    : inferQuantityFallback(cleaned);
  const unit = match.groups.unit ?? inferUnitFallback(cleaned);

  return {
    rawName: name,
    quantity,
    unit,
    confidence: 0.6,
  };
}

function inferQuantityFallback(line: string): number {
  const match = line.match(/(?:x|qty\s*:?\s*)(\d+(?:\.\d+)?)/i) ?? line.match(/(\d+(?:\.\d+)?)/);
  if (!match?.[1]) {
    return 1;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

function inferUnitFallback(line: string): string {
  const lowered = line.toLowerCase();
  if (lowered.includes("kg")) {
    return "kg";
  }
  if (lowered.includes(" g")) {
    return "g";
  }
  if (lowered.includes("lb")) {
    return "lb";
  }
  if (lowered.includes("oz")) {
    return "oz";
  }
  if (lowered.includes("ml")) {
    return "ml";
  }
  if (lowered.includes(" l")) {
    return "l";
  }
  if (lowered.includes("pack")) {
    return "pack";
  }
  if (lowered.includes("box")) {
    return "box";
  }
  if (lowered.includes("bottle")) {
    return "bottle";
  }
  return "count";
}
