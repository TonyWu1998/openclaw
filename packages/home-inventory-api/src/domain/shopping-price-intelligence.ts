export type PricePoint = {
  purchasedAt: string;
  unitPrice: number;
};

export type PriceIntelligence = {
  lastUnitPrice?: number;
  avgUnitPrice30d?: number;
  minUnitPrice90d?: number;
  priceTrendPct?: number;
  priceAlert: boolean;
};

const TREND_ALERT_THRESHOLD_PCT = 15;
const LAST_TO_MIN_ALERT_MULTIPLIER = 1.25;
const DAY_MS = 24 * 60 * 60 * 1000;

export function computePriceIntelligence(
  points: PricePoint[],
  asOf: string = new Date().toISOString(),
): PriceIntelligence {
  const asOfDate = new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) {
    return { priceAlert: false };
  }

  const normalized = points
    .filter((point) => Number.isFinite(point.unitPrice) && point.unitPrice > 0)
    .map((point) => ({
      purchasedAt: point.purchasedAt,
      unitPrice: round(point.unitPrice),
      timestamp: new Date(point.purchasedAt).getTime(),
    }))
    .filter((point) => Number.isFinite(point.timestamp))
    .toSorted((a, b) => b.timestamp - a.timestamp);

  if (normalized.length === 0) {
    return { priceAlert: false };
  }

  const lastUnitPrice = normalized[0]?.unitPrice;
  const within30 = normalized
    .filter((point) => daysSince(point.timestamp, asOfDate.getTime()) <= 30)
    .map((point) => point.unitPrice);
  const within90 = normalized
    .filter((point) => daysSince(point.timestamp, asOfDate.getTime()) <= 90)
    .map((point) => point.unitPrice);

  const avgUnitPrice30d = within30.length > 0 ? round(average(within30)) : undefined;
  const minUnitPrice90d = within90.length > 0 ? round(Math.min(...within90)) : undefined;

  const priceTrendPct =
    lastUnitPrice !== undefined && avgUnitPrice30d !== undefined && avgUnitPrice30d > 0
      ? round(((lastUnitPrice - avgUnitPrice30d) / avgUnitPrice30d) * 100)
      : undefined;

  const trendAlert = (priceTrendPct ?? 0) >= TREND_ALERT_THRESHOLD_PCT;
  const minAlert =
    lastUnitPrice !== undefined &&
    minUnitPrice90d !== undefined &&
    minUnitPrice90d > 0 &&
    lastUnitPrice >= minUnitPrice90d * LAST_TO_MIN_ALERT_MULTIPLIER;

  return {
    lastUnitPrice,
    avgUnitPrice30d,
    minUnitPrice90d,
    priceTrendPct,
    priceAlert: trendAlert || minAlert,
  };
}

function daysSince(timestamp: number, asOfTimestamp: number): number {
  const delta = asOfTimestamp - timestamp;
  if (!Number.isFinite(delta) || delta < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return delta / DAY_MS;
}

function average(values: number[]): number {
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function round(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}
