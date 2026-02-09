import type { OpenClawPluginApi } from "../../src/plugins/types.js";

type HomeInventoryConfig = {
  apiBaseUrl: string;
  defaultHouseholdId?: string;
  scheduleEnabled: boolean;
  dailyHour: number;
  weeklyDay: number;
  weeklyHour: number;
};

type ApiRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
};

const DEFAULT_CONFIG: HomeInventoryConfig = {
  apiBaseUrl: "http://127.0.0.1:8789",
  scheduleEnabled: false,
  dailyHour: 6,
  weeklyDay: 0,
  weeklyHour: 8,
};

export default function register(api: OpenClawPluginApi) {
  const config = readConfig(api);
  let schedulerTimer: ReturnType<typeof setInterval> | undefined;
  let lastDailyKey = "";
  let lastWeeklyKey = "";

  const request = (params: ApiRequest) =>
    callInventoryApi({
      baseUrl: config.apiBaseUrl,
      method: params.method,
      path: params.path,
      body: params.body,
    });

  api.registerGatewayMethod("inventory.receipt.process", async ({ params, respond }) => {
    const receiptUploadId = stringParam(params, "receiptUploadId");
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;

    if (!receiptUploadId || !householdId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "receiptUploadId and householdId are required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/receipts/${encodeURIComponent(receiptUploadId)}/process`,
        body: {
          householdId,
          ocrText: optionalStringParam(params, "ocrText"),
          merchantName: optionalStringParam(params, "merchantName"),
          purchasedAt: optionalStringParam(params, "purchasedAt"),
        },
      });
      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.receipt.process failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.plan.daily", async ({ params, respond }) => {
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    if (!householdId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "householdId is required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/recommendations/${encodeURIComponent(householdId)}/daily/generate`,
        body: {
          date: optionalStringParam(params, "date"),
        },
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.plan.daily failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.plan.weekly", async ({ params, respond }) => {
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    if (!householdId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "householdId is required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/recommendations/${encodeURIComponent(householdId)}/weekly/generate`,
        body: {
          weekOf: optionalStringParam(params, "weekOf"),
        },
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.plan.weekly failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.checkin.pending", async ({ params, respond }) => {
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    if (!householdId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "householdId is required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "GET",
        path: `/v1/checkins/${encodeURIComponent(householdId)}/pending`,
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.checkin.pending failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.checkin.submit", async ({ params, respond }) => {
    const checkinId = stringParam(params, "checkinId");
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    const outcome = stringParam(params, "outcome");

    if (!checkinId || !householdId || !outcome) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "checkinId, householdId, and outcome are required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/checkins/${encodeURIComponent(checkinId)}/submit`,
        body: {
          householdId,
          outcome,
          lines: arrayParam(params, "lines"),
          notes: optionalStringParam(params, "notes"),
          idempotencyKey: optionalStringParam(params, "idempotencyKey"),
        },
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.checkin.submit failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.shopping.generate", async ({ params, respond }) => {
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    if (!householdId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "householdId is required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/shopping-drafts/${encodeURIComponent(householdId)}/generate`,
        body: {
          weekOf: optionalStringParam(params, "weekOf"),
          regenerate: booleanParam(params, "regenerate"),
        },
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.shopping.generate failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerGatewayMethod("inventory.recommendation.feedback", async ({ params, respond }) => {
    const recommendationId = stringParam(params, "recommendationId");
    const householdId = stringParam(params, "householdId") ?? config.defaultHouseholdId;
    const signalType = stringParam(params, "signalType");

    if (!recommendationId || !householdId || !signalType) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "recommendationId, householdId, and signalType are required",
      });
      return;
    }

    try {
      const payload = await request({
        method: "POST",
        path: `/v1/recommendations/${encodeURIComponent(recommendationId)}/feedback`,
        body: {
          householdId,
          signalType,
          signalValue: numberParam(params, "signalValue"),
          context: optionalStringParam(params, "context"),
        },
      });

      respond(true, payload);
    } catch (error) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: `inventory.recommendation.feedback failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  api.registerService({
    id: "home-inventory-scheduler",
    start: async ({ logger }) => {
      if (!config.scheduleEnabled || !config.defaultHouseholdId) {
        logger.info("home-inventory scheduler disabled");
        return;
      }

      if (schedulerTimer) {
        clearInterval(schedulerTimer);
      }

      const tick = async () => {
        const now = new Date();
        const date = now.toISOString().slice(0, 10);

        if (now.getHours() === config.dailyHour && lastDailyKey !== date) {
          lastDailyKey = date;
          try {
            await request({
              method: "POST",
              path: `/v1/recommendations/${encodeURIComponent(config.defaultHouseholdId!)}/daily/generate`,
              body: { date },
            });
            logger.info(`home-inventory daily schedule ran for ${config.defaultHouseholdId}`);
          } catch (error) {
            logger.warn(`home-inventory daily schedule failed: ${String(error)}`);
          }
        }

        const weeklyKey = `${date}-d${now.getDay()}`;
        if (
          now.getDay() === config.weeklyDay &&
          now.getHours() === config.weeklyHour &&
          lastWeeklyKey !== weeklyKey
        ) {
          lastWeeklyKey = weeklyKey;
          try {
            await request({
              method: "POST",
              path: `/v1/recommendations/${encodeURIComponent(config.defaultHouseholdId!)}/weekly/generate`,
              body: { weekOf: date },
            });
            logger.info(`home-inventory weekly schedule ran for ${config.defaultHouseholdId}`);
          } catch (error) {
            logger.warn(`home-inventory weekly schedule failed: ${String(error)}`);
          }
        }
      };

      schedulerTimer = setInterval(() => {
        void tick();
      }, 60_000);

      // Run one initial non-blocking tick so startup can catch schedule windows quickly.
      void tick();
    },
    stop: async () => {
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = undefined;
      }
    },
  });
}

function readConfig(api: OpenClawPluginApi): HomeInventoryConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    apiBaseUrl: stringFromValue(raw.apiBaseUrl, DEFAULT_CONFIG.apiBaseUrl),
    defaultHouseholdId: optionalStringFromValue(raw.defaultHouseholdId),
    scheduleEnabled: booleanFromValue(raw.scheduleEnabled, DEFAULT_CONFIG.scheduleEnabled),
    dailyHour: clampHour(numberFromValue(raw.dailyHour, DEFAULT_CONFIG.dailyHour)),
    weeklyDay: clampDay(numberFromValue(raw.weeklyDay, DEFAULT_CONFIG.weeklyDay)),
    weeklyHour: clampHour(numberFromValue(raw.weeklyHour, DEFAULT_CONFIG.weeklyHour)),
  };
}

async function callInventoryApi(params: {
  baseUrl: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}): Promise<unknown> {
  const url = `${params.baseUrl.replace(/\/$/, "")}${params.path}`;
  const response = await fetch(url, {
    method: params.method,
    headers: {
      "content-type": "application/json",
    },
    body:
      params.method === "POST" || params.method === "PATCH"
        ? JSON.stringify(params.body ?? {})
        : undefined,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  return stringParam(params, key);
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return undefined;
}

function arrayParam(params: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = params[key];
  return Array.isArray(value) ? value : undefined;
}

function stringFromValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalStringFromValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanFromValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberFromValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function clampHour(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.dailyHour;
  }
  return Math.max(0, Math.min(23, Math.round(value)));
}

function clampDay(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.weeklyDay;
  }
  return Math.max(0, Math.min(6, Math.round(value)));
}
