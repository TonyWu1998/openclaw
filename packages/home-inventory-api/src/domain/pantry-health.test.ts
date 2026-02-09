import type { InventorySnapshotResponse, MealCheckin } from "@openclaw/home-inventory-contracts";
import { describe, expect, it } from "vitest";
import { computePantryHealthScore } from "./pantry-health.js";

function inventoryFixture(
  overrides: Partial<InventorySnapshotResponse>,
): InventorySnapshotResponse {
  return {
    householdId: "household_test",
    lots: [],
    events: [],
    ...overrides,
  };
}

function checkinsFixture(entries: MealCheckin[]): MealCheckin[] {
  return entries;
}

describe("computePantryHealthScore", () => {
  it("returns a strong score for balanced inventory with low risk", () => {
    const score = computePantryHealthScore({
      householdId: "household_test",
      asOf: "2026-02-09T12:00:00.000Z",
      inventory: inventoryFixture({
        lots: [
          {
            lotId: "lot_1",
            householdId: "household_test",
            itemKey: "rice",
            itemName: "Jasmine Rice",
            quantityRemaining: 2,
            unit: "kg",
            category: "grain",
            expiresAt: "2026-08-01T00:00:00.000Z",
            expiryEstimatedAt: "2026-08-01T00:00:00.000Z",
            expirySource: "estimated",
            expiryConfidence: 0.8,
            updatedAt: "2026-02-08T12:00:00.000Z",
          },
          {
            lotId: "lot_2",
            householdId: "household_test",
            itemKey: "milk",
            itemName: "Milk",
            quantityRemaining: 1.5,
            unit: "l",
            category: "dairy",
            expiresAt: "2026-02-18T00:00:00.000Z",
            expiryEstimatedAt: "2026-02-18T00:00:00.000Z",
            expirySource: "exact",
            expiryConfidence: 1,
            updatedAt: "2026-02-08T12:00:00.000Z",
          },
        ],
        events: [
          {
            eventId: "event_1",
            householdId: "household_test",
            lotId: "lot_2",
            eventType: "consume",
            quantity: 0.5,
            unit: "l",
            source: "checkin",
            createdAt: "2026-02-09T10:00:00.000Z",
          },
        ],
      }),
      expiryRisk: {
        householdId: "household_test",
        asOf: "2026-02-09T12:00:00.000Z",
        items: [
          {
            lotId: "lot_2",
            itemKey: "milk",
            itemName: "Milk",
            category: "dairy",
            quantityRemaining: 1.5,
            unit: "l",
            expiresAt: "2026-02-18T00:00:00.000Z",
            expirySource: "exact",
            expiryConfidence: 1,
            daysRemaining: 9,
            riskLevel: "medium",
          },
        ],
      },
      checkins: checkinsFixture([
        {
          checkinId: "checkin_1",
          recommendationId: "rec_1",
          householdId: "household_test",
          mealDate: "2026-02-09",
          title: "Rice bowl",
          suggestedItemKeys: ["rice", "milk"],
          status: "completed",
          outcome: "made",
          createdAt: "2026-02-09T08:00:00.000Z",
          updatedAt: "2026-02-09T20:00:00.000Z",
        },
      ]),
    });

    expect(score.score).toBeGreaterThan(70);
    expect(score.subscores.expiry_risk).toBeGreaterThan(60);
    expect(score.subscores.plan_adherence).toBeGreaterThan(80);
  });

  it("drops score when waste and expiry risk are high", () => {
    const score = computePantryHealthScore({
      householdId: "household_test",
      asOf: "2026-02-09T12:00:00.000Z",
      inventory: inventoryFixture({
        lots: [
          {
            lotId: "lot_1",
            householdId: "household_test",
            itemKey: "chicken",
            itemName: "Chicken",
            quantityRemaining: 0.3,
            unit: "kg",
            category: "protein",
            expiresAt: "2026-02-10T00:00:00.000Z",
            expiryEstimatedAt: "2026-02-10T00:00:00.000Z",
            expirySource: "estimated",
            expiryConfidence: 0.5,
            updatedAt: "2026-02-08T12:00:00.000Z",
          },
        ],
        events: [
          {
            eventId: "event_1",
            householdId: "household_test",
            lotId: "lot_1",
            eventType: "waste",
            quantity: 1,
            unit: "kg",
            source: "checkin",
            createdAt: "2026-02-09T10:00:00.000Z",
          },
        ],
      }),
      expiryRisk: {
        householdId: "household_test",
        asOf: "2026-02-09T12:00:00.000Z",
        items: [
          {
            lotId: "lot_1",
            itemKey: "chicken",
            itemName: "Chicken",
            category: "protein",
            quantityRemaining: 0.3,
            unit: "kg",
            expiresAt: "2026-02-10T00:00:00.000Z",
            expirySource: "estimated",
            expiryConfidence: 0.5,
            daysRemaining: 1,
            riskLevel: "critical",
          },
        ],
      },
      checkins: checkinsFixture([
        {
          checkinId: "checkin_1",
          recommendationId: "rec_1",
          householdId: "household_test",
          mealDate: "2026-02-09",
          title: "Chicken stir-fry",
          suggestedItemKeys: ["chicken"],
          status: "needs_adjustment",
          outcome: "skipped",
          createdAt: "2026-02-09T08:00:00.000Z",
          updatedAt: "2026-02-09T20:00:00.000Z",
        },
      ]),
    });

    expect(score.subscores.expiry_risk).toBeLessThan(40);
    expect(score.subscores.waste_pressure).toBeLessThan(20);
    expect(score.score).toBeLessThan(60);
  });
});
