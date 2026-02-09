import { describe, expect, it } from "vitest";
import {
  daysUntilExpiry,
  estimateLotExpiry,
  resolveLotExpirySource,
  riskLevelFromDaysRemaining,
} from "./expiry-intelligence.js";

describe("expiry-intelligence", () => {
  it("uses configured category defaults for estimation", () => {
    const protein = estimateLotExpiry({
      category: "protein",
      purchasedAt: "2026-02-09T00:00:00.000Z",
    });
    const produce = estimateLotExpiry({
      category: "produce",
      purchasedAt: "2026-02-09T00:00:00.000Z",
    });
    const household = estimateLotExpiry({
      category: "household",
      purchasedAt: "2026-02-09T00:00:00.000Z",
    });

    expect(daysUntilExpiry(protein.expiresAt, new Date("2026-02-09T00:00:00.000Z"))).toBe(3);
    expect(daysUntilExpiry(produce.expiresAt, new Date("2026-02-09T00:00:00.000Z"))).toBe(7);
    expect(daysUntilExpiry(household.expiresAt, new Date("2026-02-09T00:00:00.000Z"))).toBe(365);
    expect(protein.expirySource).toBe("estimated");
  });

  it("maps days remaining to risk levels", () => {
    expect(riskLevelFromDaysRemaining(2)).toBe("critical");
    expect(riskLevelFromDaysRemaining(5)).toBe("high");
    expect(riskLevelFromDaysRemaining(10)).toBe("medium");
    expect(riskLevelFromDaysRemaining(11)).toBe("low");
  });

  it("resolves unknown source when lot source is absent", () => {
    const source = resolveLotExpirySource({
      lotId: "lot_1",
      householdId: "household_1",
      itemKey: "rice",
      itemName: "jasmine rice",
      quantityRemaining: 1,
      unit: "kg",
      category: "grain",
      updatedAt: "2026-02-09T00:00:00.000Z",
    });

    expect(source).toBe("unknown");
  });
});
