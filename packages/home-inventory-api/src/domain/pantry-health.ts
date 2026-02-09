import type {
  ExpiryRiskResponse,
  InventorySnapshotResponse,
  MealCheckin,
  PantryHealthScore,
} from "@openclaw/home-inventory-contracts";

type PantryHealthInput = {
  householdId: string;
  asOf?: string;
  inventory: InventorySnapshotResponse;
  expiryRisk: ExpiryRiskResponse;
  checkins: MealCheckin[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computePantryHealthScore(input: PantryHealthInput): PantryHealthScore {
  const asOf = input.asOf ?? new Date().toISOString();
  const asOfTimestamp = toTimestamp(asOf);

  const stockBalance = computeStockBalance(input.inventory);
  const expiryRisk = computeExpiryRisk(input.expiryRisk);
  const wastePressure = computeWastePressure(input.inventory, asOfTimestamp);
  const planAdherence = computePlanAdherence(input.checkins, asOfTimestamp);
  const dataQuality = computeDataQuality(input.inventory);

  const weightedScore =
    stockBalance * 0.25 +
    expiryRisk * 0.25 +
    wastePressure * 0.2 +
    planAdherence * 0.2 +
    dataQuality * 0.1;

  return {
    householdId: input.householdId,
    asOf,
    score: round(clamp(weightedScore)),
    subscores: {
      stock_balance: round(stockBalance),
      expiry_risk: round(expiryRisk),
      waste_pressure: round(wastePressure),
      plan_adherence: round(planAdherence),
      data_quality: round(dataQuality),
    },
  };
}

function computeStockBalance(inventory: InventorySnapshotResponse): number {
  const activeLots = inventory.lots.filter((lot) => lot.quantityRemaining > 0);
  if (activeLots.length === 0) {
    return 30;
  }

  const categories = new Set(activeLots.map((lot) => lot.category));
  const lowStockCount = activeLots.filter(
    (lot) => lot.quantityRemaining < lowStockThreshold(lot.unit),
  ).length;
  const oversupplyCount = activeLots.filter(
    (lot) => lot.quantityRemaining > lowStockThreshold(lot.unit) * 4,
  ).length;

  const categoryCoverage = Math.min(1, categories.size / 6);
  const lowStockPenalty = (lowStockCount / activeLots.length) * 35;
  const oversupplyPenalty = (oversupplyCount / activeLots.length) * 15;

  return clamp(40 + categoryCoverage * 60 - lowStockPenalty - oversupplyPenalty);
}

function computeExpiryRisk(expiryRisk: ExpiryRiskResponse): number {
  if (expiryRisk.items.length === 0) {
    return 100;
  }

  const weighted = expiryRisk.items.reduce((sum, item) => {
    switch (item.riskLevel) {
      case "critical":
        return sum + 1;
      case "high":
        return sum + 0.6;
      case "medium":
        return sum + 0.3;
      case "low":
      default:
        return sum + 0.1;
    }
  }, 0);

  return clamp(100 - (weighted / expiryRisk.items.length) * 100);
}

function computeWastePressure(inventory: InventorySnapshotResponse, asOfTimestamp: number): number {
  const recentEvents = inventory.events.filter((event) =>
    isWithinDays(event.createdAt, asOfTimestamp, 14),
  );

  const consumeTotal = recentEvents
    .filter((event) => event.eventType === "consume")
    .reduce((sum, event) => sum + event.quantity, 0);
  const wasteTotal = recentEvents
    .filter((event) => event.eventType === "waste")
    .reduce((sum, event) => sum + event.quantity, 0);

  if (consumeTotal + wasteTotal <= 0) {
    return 70;
  }

  const wasteRatio = wasteTotal / (consumeTotal + wasteTotal);
  return clamp(100 - wasteRatio * 100);
}

function computePlanAdherence(checkins: MealCheckin[], asOfTimestamp: number): number {
  const recentCheckins = checkins.filter((checkin) =>
    isWithinDays(`${checkin.mealDate}T00:00:00.000Z`, asOfTimestamp, 7),
  );

  if (recentCheckins.length === 0) {
    return 60;
  }

  const completed = recentCheckins.filter((checkin) => checkin.status === "completed").length;
  const needsAdjustment = recentCheckins.filter(
    (checkin) => checkin.status === "needs_adjustment",
  ).length;
  const skipped = recentCheckins.filter((checkin) => checkin.outcome === "skipped").length;

  const completionRatio = completed / recentCheckins.length;
  const needsAdjustmentPenalty = (needsAdjustment / recentCheckins.length) * 20;
  const skippedPenalty = (skipped / recentCheckins.length) * 10;

  return clamp(completionRatio * 100 - needsAdjustmentPenalty - skippedPenalty);
}

function computeDataQuality(inventory: InventorySnapshotResponse): number {
  if (inventory.lots.length === 0) {
    return 55;
  }

  const expiryKnownCount = inventory.lots.filter((lot) =>
    Boolean(lot.expiresAt || lot.expiryEstimatedAt),
  ).length;
  const highConfidenceCount = inventory.lots.filter(
    (lot) => (lot.expiryConfidence ?? 0) >= 0.7,
  ).length;
  const manualEventCount = inventory.events.filter((event) => event.source === "manual").length;

  const expiryCoverage = expiryKnownCount / inventory.lots.length;
  const confidenceCoverage = highConfidenceCount / inventory.lots.length;
  const manualRatio = manualEventCount / Math.max(1, inventory.events.length);

  return clamp(35 + expiryCoverage * 40 + confidenceCoverage * 25 - manualRatio * 15);
}

function isWithinDays(timestamp: string, asOfTimestamp: number, days: number): boolean {
  const value = toTimestamp(timestamp);
  if (!Number.isFinite(value)) {
    return false;
  }
  const delta = asOfTimestamp - value;
  return delta >= 0 && delta <= days * DAY_MS;
}

function toTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function lowStockThreshold(unit: string): number {
  switch (unit) {
    case "count":
      return 4;
    case "kg":
    case "lb":
      return 1;
    case "l":
      return 1;
    case "ml":
      return 500;
    case "oz":
      return 16;
    default:
      return 2;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function round(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}
