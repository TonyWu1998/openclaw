import { describe, expect, it } from "vitest";
import { normalizeDraftItems } from "./normalization.js";

describe("normalizeDraftItems", () => {
  it("canonicalizes units/categories and merges duplicate lines", () => {
    const normalized = normalizeDraftItems([
      {
        rawName: "Jasmine Rice",
        quantity: 1,
        unit: "kg",
        confidence: 0.8,
      },
      {
        rawName: "Jasmine Rice",
        quantity: 0.5,
        unit: "kilograms",
        confidence: 0.9,
      },
      {
        rawName: "Tomato",
        quantity: 4,
        unit: "x",
      },
    ]);

    expect(normalized).toHaveLength(2);

    const rice = normalized.find((item) => item.itemKey === "jasmine-rice");
    expect(rice?.unit).toBe("kg");
    expect(rice?.quantity).toBe(1.5);
    expect(rice?.category).toBe("grain");
    expect(rice?.confidence).toBe(0.9);

    const tomato = normalized.find((item) => item.itemKey === "tomato");
    expect(tomato?.unit).toBe("count");
    expect(tomato?.category).toBe("produce");
  });

  it("defaults invalid values to safe normalized output", () => {
    const normalized = normalizeDraftItems([
      {
        rawName: "Mystery Item",
        quantity: -10,
        unit: "???",
        confidence: 99,
      },
    ]);

    expect(normalized).toEqual([
      {
        itemKey: "mystery-item",
        rawName: "Mystery Item",
        normalizedName: "mystery item",
        quantity: 1,
        unit: "count",
        category: "other",
        confidence: 1,
      },
    ]);
  });
});
