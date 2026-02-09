import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiReceiptExtractor } from "./openai-extractor.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiReceiptExtractor", () => {
  it("extracts structured items from responses API payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify([
              {
                rawName: "Jasmine Rice 2kg",
                normalizedName: "jasmine rice",
                quantity: 2,
                unit: "kg",
                category: "grain",
                confidence: 0.91,
              },
            ]),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const extractor = new OpenAiReceiptExtractor({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-5.2-mini",
    });

    const items = await extractor.extract({
      merchantName: "Fresh Market",
      ocrText: "Jasmine Rice 2kg",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(items).toHaveLength(1);
    expect(items[0]?.rawName).toBe("Jasmine Rice 2kg");
    expect(items[0]?.unit).toBe("kg");
  });

  it("extracts structured items from chat-completions payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      rawName: "Tomato",
                      normalizedName: "tomato",
                      quantity: 4,
                      unit: "count",
                      category: "produce",
                      confidence: 0.87,
                    },
                  ]),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const extractor = new OpenAiReceiptExtractor({
      provider: "lmstudio",
      model: "qwen2.5-7b-instruct",
      baseUrl: "http://127.0.0.1:1234/v1",
      requestMode: "chat_completions",
    });

    const items = await extractor.extract({
      merchantName: "Local Shop",
      ocrText: "Tomato x4",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(items).toHaveLength(1);
    expect(items[0]?.rawName).toBe("Tomato");
    expect(items[0]?.category).toBe("produce");
  });
});
