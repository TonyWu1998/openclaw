import type {
  ExpiryRiskLevel,
  ExpirySource,
  InventoryLot,
  ItemCategory,
} from "@openclaw/home-inventory-contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_DAYS_BY_CATEGORY: Record<ItemCategory, number> = {
  protein: 3,
  produce: 7,
  dairy: 10,
  frozen: 120,
  grain: 180,
  snack: 90,
  beverage: 30,
  condiment: 180,
  household: 365,
  other: 30,
};

const EXPIRY_CONFIDENCE_BY_CATEGORY: Record<ItemCategory, number> = {
  protein: 0.7,
  produce: 0.65,
  dairy: 0.7,
  frozen: 0.6,
  grain: 0.55,
  snack: 0.55,
  beverage: 0.6,
  condiment: 0.5,
  household: 0.45,
  other: 0.5,
};

export type EstimatedExpiry = {
  expiresAt: string;
  expiryEstimatedAt: string;
  expirySource: ExpirySource;
  expiryConfidence: number;
};

export function estimateLotExpiry(params: {
  category: ItemCategory;
  purchasedAt?: string;
  now?: Date;
}): EstimatedExpiry {
  const purchasedAtDate = toDateOr(params.purchasedAt, params.now ?? new Date());
  const days = EXPIRY_DAYS_BY_CATEGORY[params.category] ?? EXPIRY_DAYS_BY_CATEGORY.other;
  const estimated = new Date(purchasedAtDate.getTime() + days * DAY_MS).toISOString();

  return {
    expiresAt: estimated,
    expiryEstimatedAt: estimated,
    expirySource: "estimated",
    expiryConfidence: EXPIRY_CONFIDENCE_BY_CATEGORY[params.category] ?? 0.5,
  };
}

export function daysUntilExpiry(expiresAt: string, asOf: Date = new Date()): number {
  const expiry = new Date(expiresAt).getTime();
  const reference = asOf.getTime();
  return Math.ceil((expiry - reference) / DAY_MS);
}

export function riskLevelFromDaysRemaining(daysRemaining: number): ExpiryRiskLevel {
  if (daysRemaining <= 2) {
    return "critical";
  }
  if (daysRemaining <= 5) {
    return "high";
  }
  if (daysRemaining <= 10) {
    return "medium";
  }
  return "low";
}

export function resolveLotExpirySource(lot: InventoryLot): ExpirySource {
  if (lot.expirySource === "exact" || lot.expirySource === "estimated") {
    return lot.expirySource;
  }
  return "unknown";
}

function toDateOr(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed;
}
