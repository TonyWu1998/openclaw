import sharp from "sharp";

export type ReceiptImagePreprocessOptions = {
  maxLongestSide?: number;
  jpegQuality?: number;
};

const DEFAULT_MAX_LONGEST_SIDE = 1600;
const DEFAULT_JPEG_QUALITY = 75;
const DATA_URL_PREFIX = "data:image/";

export async function preprocessReceiptImageDataUrl(
  dataUrl: string | undefined,
  options: ReceiptImagePreprocessOptions = {},
): Promise<string | undefined> {
  const normalized = normalizeImageDataUrl(dataUrl);
  if (!normalized) {
    return undefined;
  }

  const parsed = parseImageDataUrl(normalized);
  if (!parsed) {
    return normalized;
  }

  const maxLongestSide = options.maxLongestSide ?? DEFAULT_MAX_LONGEST_SIDE;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;

  try {
    const inputBuffer = Buffer.from(parsed.base64, "base64");
    if (inputBuffer.length === 0) {
      return normalized;
    }

    const metadata = await sharp(inputBuffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      return normalized;
    }

    const longestSide = Math.max(width, height);
    if (longestSide <= maxLongestSide) {
      return normalized;
    }

    const outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({
        width: maxLongestSide,
        height: maxLongestSide,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();

    return `data:image/jpeg;base64,${outputBuffer.toString("base64")}`;
  } catch {
    return normalized;
  }
}

function normalizeImageDataUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith(DATA_URL_PREFIX)) {
    return undefined;
  }

  return trimmed;
}

function parseImageDataUrl(dataUrl: string): { base64: string } | null {
  const match = dataUrl.match(/^data:image\/[A-Za-z0-9.+-]+;base64,(?<base64>[A-Za-z0-9+/=]+)$/);
  const base64 = match?.groups?.base64;
  if (!base64) {
    return null;
  }

  return { base64 };
}
