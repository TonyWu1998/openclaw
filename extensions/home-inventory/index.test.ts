import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerHomeInventory from "./index.js";

type PluginHarness = {
  api: OpenClawPluginApi;
  gatewayMethods: Map<
    string,
    (opts: { params: Record<string, unknown>; respond: (...args: unknown[]) => void }) => unknown
  >;
  services: OpenClawPluginService[];
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
};

function createHarness(pluginConfig: Record<string, unknown>): PluginHarness {
  const gatewayMethods = new Map<
    string,
    (opts: { params: Record<string, unknown>; respond: (...args: unknown[]) => void }) => unknown
  >();
  const services: OpenClawPluginService[] = [];

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api = {
    id: "home-inventory",
    name: "home-inventory",
    version: "test",
    description: "test",
    source: "extensions/home-inventory/index.ts",
    config: {} as OpenClawConfig,
    pluginConfig,
    runtime: {} as PluginRuntime,
    logger,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn((method, handler) => {
      gatewayMethods.set(
        method,
        handler as PluginHarness["gatewayMethods"] extends Map<string, infer H> ? H : never,
      );
    }),
    registerCli: vi.fn(),
    registerService: vi.fn((service) => {
      services.push(service);
    }),
    registerProvider: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    gatewayMethods,
    services,
    logger,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("home-inventory extension", () => {
  it("proxies daily plan generation through gateway method", async () => {
    const payload = { ok: true, runId: "run_1" };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const harness = createHarness({
      apiBaseUrl: "http://inventory.local",
      defaultHouseholdId: "household_default",
    });

    registerHomeInventory(harness.api);

    const method = harness.gatewayMethods.get("inventory.plan.daily");
    expect(method).toBeDefined();

    const respond = vi.fn();
    await method?.({
      params: {
        householdId: "household_main",
        date: "2026-02-09",
      },
      respond,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://inventory.local/v1/recommendations/household_main/daily/generate",
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(String(requestInit.body))).toEqual({ date: "2026-02-09" });

    expect(respond).toHaveBeenCalledWith(true, payload);
  });

  it("runs scheduler windows once per date and clears timer on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T08:05:00-08:00"));
    const now = new Date();

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const harness = createHarness({
      apiBaseUrl: "http://inventory.local",
      defaultHouseholdId: "household_main",
      scheduleEnabled: true,
      dailyHour: now.getHours(),
      weeklyDay: now.getDay(),
      weeklyHour: (now.getHours() + 1) % 24,
    });

    registerHomeInventory(harness.api);

    const service = harness.services.find((entry) => entry.id === "home-inventory-scheduler");
    expect(service).toBeDefined();

    const serviceContext = {
      config: {} as OpenClawConfig,
      stateDir: "/tmp/home-inventory-test",
      logger: harness.logger,
    };

    await service?.start(serviceContext);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://inventory.local/v1/recommendations/household_main/daily/generate",
    ]);

    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service?.stop?.(serviceContext);

    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
