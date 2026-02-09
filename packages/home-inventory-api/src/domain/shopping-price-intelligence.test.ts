import { describe, expect, it } from "vitest";
import { computePriceIntelligence } from "./shopping-price-intelligence.js";

describe("computePriceIntelligence", () => {
  it("returns no alert when price history is missing", () => {
    const result = computePriceIntelligence([], "2026-02-09T00:00:00.000Z");
    expect(result.priceAlert).toBe(false);
    expect(result.lastUnitPrice).toBeUndefined();
  });

  it("calculates trend and alerts on sharp increases", () => {
    const result = computePriceIntelligence(
      [
        { unitPrice: 3.2, purchasedAt: "2026-02-08T00:00:00.000Z" },
        { unitPrice: 2.4, purchasedAt: "2026-01-25T00:00:00.000Z" },
        { unitPrice: 2.3, purchasedAt: "2026-01-12T00:00:00.000Z" },
      ],
      "2026-02-09T00:00:00.000Z",
    );

    expect(result.lastUnitPrice).toBe(3.2);
    expect(result.avgUnitPrice30d).toBe(2.633);
    expect(result.minUnitPrice90d).toBe(2.3);
    expect(result.priceTrendPct).toBeGreaterThan(15);
    expect(result.priceAlert).toBe(true);
  });

  it("keeps alert false when trend is stable", () => {
    const result = computePriceIntelligence(
      [
        { unitPrice: 2.5, purchasedAt: "2026-02-08T00:00:00.000Z" },
        { unitPrice: 2.45, purchasedAt: "2026-01-28T00:00:00.000Z" },
      ],
      "2026-02-09T00:00:00.000Z",
    );

    expect(result.priceTrendPct).toBeLessThan(15);
    expect(result.priceAlert).toBe(false);
  });
});
