import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { preprocessReceiptImageDataUrl } from "./image-preprocessor.js";

async function createImageDataUrl(
  width: number,
  height: number,
  format: "png" | "jpeg",
): Promise<string> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 120, b: 80 },
    },
  });

  const buffer =
    format === "png" ? await image.png().toBuffer() : await image.jpeg({ quality: 90 }).toBuffer();

  return `data:image/${format};base64,${buffer.toString("base64")}`;
}

function decodeDataUrl(dataUrl: string): Buffer {
  const base64 = dataUrl.split(",")[1];
  if (!base64) {
    throw new Error("invalid data url");
  }
  return Buffer.from(base64, "base64");
}

describe("preprocessReceiptImageDataUrl", () => {
  it("keeps the original image when already within the size threshold", async () => {
    const input = await createImageDataUrl(1200, 900, "jpeg");
    const output = await preprocessReceiptImageDataUrl(input);
    expect(output).toBe(input);
  });

  it("resizes large images to 1600px max side and outputs jpeg", async () => {
    const input = await createImageDataUrl(2800, 1800, "png");
    const output = await preprocessReceiptImageDataUrl(input);

    expect(output).toBeDefined();
    expect(output).not.toBe(input);
    expect(output?.startsWith("data:image/jpeg;base64,")).toBe(true);

    const metadata = await sharp(decodeDataUrl(output!)).metadata();
    const longestSide = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    expect(longestSide).toBeLessThanOrEqual(1600);
  });

  it("returns the original input for invalid image payloads", async () => {
    const input = "data:image/jpeg;base64,not-base64###";
    const output = await preprocessReceiptImageDataUrl(input);
    expect(output).toBe(input);
  });
});
