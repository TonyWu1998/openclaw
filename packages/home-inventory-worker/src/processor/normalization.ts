import type { ItemCategory, ReceiptItem, Unit } from "@openclaw/home-inventory-contracts";
import type { DraftReceiptItem } from "./types.js";

const UNIT_ALIASES: Record<string, Unit> = {
  count: "count",
  each: "count",
  ea: "count",
  x: "count",
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  pack: "pack",
  packet: "pack",
  box: "box",
  bottle: "bottle",
};

const CATEGORY_KEYWORDS: Array<{ category: ItemCategory; keywords: string[] }> = [
  { category: "grain", keywords: ["rice", "flour", "pasta", "noodle", "oat"] },
  { category: "produce", keywords: ["tomato", "onion", "potato", "apple", "lettuce", "cabbage"] },
  { category: "protein", keywords: ["chicken", "beef", "pork", "fish", "egg", "tofu", "shrimp"] },
  { category: "dairy", keywords: ["milk", "cheese", "yogurt", "butter"] },
  { category: "snack", keywords: ["chips", "cookie", "cracker", "candy"] },
  { category: "beverage", keywords: ["juice", "soda", "tea", "coffee", "water"] },
  { category: "condiment", keywords: ["soy sauce", "vinegar", "salt", "pepper", "ketchup"] },
  { category: "frozen", keywords: ["frozen", "ice cream", "dumpling"] },
  { category: "household", keywords: ["detergent", "tissue", "toilet paper", "soap", "trash bag"] },
];

export function normalizeDraftItems(items: DraftReceiptItem[]): ReceiptItem[] {
  const merged = new Map<string, ReceiptItem>();

  for (const item of items) {
    const rawName = compactWhitespace(item.rawName);
    if (!rawName) {
      continue;
    }

    const normalizedName = normalizeName(item.normalizedName ?? rawName);
    const itemKey = toItemKey(normalizedName);
    const unit = normalizeUnit(item.unit);
    const category = normalizeCategory(item.category, normalizedName);
    const quantity = normalizeQuantity(item.quantity);
    const confidence = normalizeConfidence(item.confidence);

    const key = `${itemKey}:${unit}:${category}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        itemKey,
        rawName,
        normalizedName,
        quantity,
        unit,
        category,
        confidence,
        unitPrice: sanitizePrice(item.unitPrice),
        lineTotal: sanitizePrice(item.lineTotal),
      });
      continue;
    }

    existing.quantity += quantity;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.rawName = `${existing.rawName}; ${rawName}`;

    if (existing.lineTotal !== undefined || item.lineTotal !== undefined) {
      existing.lineTotal = (existing.lineTotal ?? 0) + (sanitizePrice(item.lineTotal) ?? 0);
    }

    if (existing.unitPrice === undefined) {
      existing.unitPrice = sanitizePrice(item.unitPrice);
    }
  }

  return [...merged.values()];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeName(name: string): string {
  return compactWhitespace(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
}

function toItemKey(name: string): string {
  const slug = name
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return slug.length > 0 ? slug : "unknown-item";
}

function normalizeUnit(unit?: string): Unit {
  if (!unit) {
    return "count";
  }

  const normalized = unit.trim().toLowerCase();
  return UNIT_ALIASES[normalized] ?? "count";
}

function normalizeCategory(category: string | undefined, normalizedName: string): ItemCategory {
  if (category) {
    const normalized = category.trim().toLowerCase();
    if (isCategory(normalized)) {
      return normalized;
    }
  }

  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some((keyword) => normalizedName.includes(keyword))) {
      return entry.category;
    }
  }

  return "other";
}

function isCategory(value: string): value is ItemCategory {
  return (
    value === "grain" ||
    value === "produce" ||
    value === "protein" ||
    value === "dairy" ||
    value === "snack" ||
    value === "beverage" ||
    value === "household" ||
    value === "condiment" ||
    value === "frozen" ||
    value === "other"
  );
}

function normalizeQuantity(quantity: number | undefined): number {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return 1;
  }
  return Number.parseFloat(quantity.toFixed(3));
}

function normalizeConfidence(confidence: number | undefined): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return 0.5;
  }
  if (confidence < 0) {
    return 0;
  }
  if (confidence > 1) {
    return 1;
  }
  return confidence;
}

function sanitizePrice(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Number.parseFloat(value.toFixed(2));
}
