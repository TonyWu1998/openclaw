import type { ItemCategory, ReceiptItem, Unit } from "@openclaw/home-inventory-contracts";

export type ReceiptExtractionInput = {
  ocrText: string;
  merchantName?: string;
};

export type DraftReceiptItem = {
  rawName: string;
  normalizedName?: string;
  quantity?: number;
  unit?: string;
  category?: string;
  confidence?: number;
  unitPrice?: number;
  lineTotal?: number;
};

export type ReceiptExtractor = {
  extract: (input: ReceiptExtractionInput) => Promise<DraftReceiptItem[]>;
};

export type NormalizedReceiptItem = ReceiptItem & {
  unit: Unit;
  category: ItemCategory;
};
