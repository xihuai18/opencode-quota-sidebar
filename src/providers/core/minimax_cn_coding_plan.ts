import { isRecord, swallow } from "../../helpers.js";
import type { QuotaSnapshot, QuotaWindow } from "../../types.js";
import {
  asNumber,
  configuredProviderEnabled,
  fetchWithTimeout,
  resolveApiKey,
  sanitizeBaseURL,
  toIso,
} from "../common.js";
import type {
  AuthValue,
  QuotaFetchContext,
  QuotaProviderAdapter,
} from "../types.js";

const MINIMAX_CN_QUOTA_URL =
  "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains";
const MINIMAX_INTL_QUOTA_URL =
  "https://www.minimax.io/v1/api/openplatform/coding_plan/remains";

function parseBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value);
  if (!normalized) return undefined;
  try {
    return new URL(normalized);
  } catch {
    return undefined;
  }
}

function isMiniMaxCodingBaseURL(value: unknown) {
  const parsed = parseBaseURL(value);
  if (!parsed || parsed.protocol !== "https:") return false;
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const isKnownHost =
    parsed.host === "api.minimaxi.com" || parsed.host === "api.minimax.io";
  if (!isKnownHost) return false;
  return (
    pathname === "/v1" ||
    pathname === "/anthropic" ||
    pathname === "/anthropic/v1"
  );
}

function quotaUrl(baseURL: unknown) {
  const parsed = parseBaseURL(baseURL);
  if (parsed?.host === "api.minimax.io") return MINIMAX_INTL_QUOTA_URL;
  return MINIMAX_CN_QUOTA_URL;
}

function percentFromRemaining(totalValue: unknown, remainingValue: unknown) {
  const total = asNumber(totalValue);
  const remaining = asNumber(remainingValue);
  if (total === undefined || remaining === undefined || total <= 0)
    return undefined;
  if (!Number.isFinite(total) || !Number.isFinite(remaining)) return undefined;
  return Math.max(0, Math.min(100, (remaining / total) * 100));
}

function windowSeconds(startTime: unknown, endTime: unknown) {
  const start = Date.parse(toIso(startTime) || "");
  const end = Date.parse(toIso(endTime) || "");
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start)
    return undefined;
  return Math.floor((end - start) / 1000);
}

function windowLabel(seconds: number | undefined, fallback: string) {
  if (!seconds || seconds <= 0) return fallback;
  const hours = seconds / 3600;
  if (hours <= 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days <= 6) return `${Math.round(days)}d`;
  return "Weekly";
}

function parseWindow(args: {
  total: unknown;
  remaining: unknown;
  startTime: unknown;
  endTime: unknown;
  fallbackLabel: string;
}): QuotaWindow | undefined {
  const remainingPercent = percentFromRemaining(args.total, args.remaining);
  if (remainingPercent === undefined) return undefined;
  return {
    label: windowLabel(
      windowSeconds(args.startTime, args.endTime),
      args.fallbackLabel,
    ),
    remainingPercent,
    resetAt: toIso(args.endTime),
  };
}

function parsePlanName(data: Record<string, unknown>) {
  const comboCard = isRecord(data.current_combo_card)
    ? data.current_combo_card
    : undefined;
  for (const value of [
    data.current_subscribe_title,
    data.plan_name,
    data.combo_title,
    data.current_plan_title,
    comboCard?.title,
  ]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

async function fetchMiniMaxCodingPlanQuota({
  providerID,
  providerOptions,
  auth,
  config,
}: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now();
  const base: Pick<
    QuotaSnapshot,
    "providerID" | "adapterID" | "label" | "shortLabel" | "sortOrder"
  > = {
    providerID,
    adapterID: "minimax-cn-coding-plan",
    label: "MiniMax Coding Plan",
    shortLabel: "MiniMax",
    sortOrder: 17,
  };

  const apiKey = resolveApiKey(auth, providerOptions);
  if (!apiKey) {
    return {
      ...base,
      status: "unavailable",
      checkedAt,
      note: "missing api key",
    };
  }

  const response = await fetchWithTimeout(
    quotaUrl(providerOptions?.baseURL),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "opencode-quota-sidebar",
      },
    },
    config.quota.requestTimeoutMs,
  ).catch(swallow("fetchMiniMaxCodingPlanQuota:usage"));

  if (!response) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "network request failed",
    };
  }

  if (!response.ok) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: `http ${response.status}`,
    };
  }

  const payload = await response
    .json()
    .catch(swallow("fetchMiniMaxCodingPlanQuota:json"));
  if (!isRecord(payload)) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "invalid response",
    };
  }

  const data = isRecord(payload.data) ? payload.data : payload;
  const baseResp = isRecord(data.base_resp)
    ? data.base_resp
    : isRecord(payload.base_resp)
      ? payload.base_resp
      : undefined;
  const statusCode = asNumber(baseResp?.status_code);
  if (statusCode !== undefined && statusCode !== 0) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note:
        typeof baseResp?.status_msg === "string" && baseResp.status_msg
          ? baseResp.status_msg
          : `status_code ${statusCode}`,
    };
  }

  const modelRemains = Array.isArray(data.model_remains)
    ? data.model_remains.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];
  const firstModel = modelRemains[0];
  if (!firstModel) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "missing model_remains",
    };
  }

  const intervalWindow = parseWindow({
    total: firstModel.current_interval_total_count,
    remaining: firstModel.current_interval_usage_count,
    startTime: firstModel.start_time,
    endTime: firstModel.end_time,
    fallbackLabel: "5h",
  });
  const weeklyWindow = parseWindow({
    total: firstModel.current_weekly_total_count,
    remaining: firstModel.current_weekly_usage_count,
    startTime: firstModel.weekly_start_time,
    endTime: firstModel.weekly_end_time,
    fallbackLabel: "Weekly",
  });
  const windows = [intervalWindow, weeklyWindow].filter(
    (value): value is QuotaWindow => Boolean(value),
  );
  const primary = windows[0];

  return {
    ...base,
    status: primary ? "ok" : "error",
    checkedAt,
    remainingPercent: primary?.remainingPercent,
    resetAt: primary?.resetAt,
    note: parsePlanName(data) || (primary ? undefined : "missing quota fields"),
    windows: windows.length > 0 ? windows : undefined,
  };
}

export const minimaxCnCodingPlanAdapter: QuotaProviderAdapter = {
  id: "minimax-cn-coding-plan",
  label: "MiniMax Coding Plan",
  shortLabel: "MiniMax",
  sortOrder: 17,
  normalizeID: (providerID) =>
    providerID === "minimax-cn-coding-plan"
      ? "minimax-cn-coding-plan"
      : undefined,
  matchScore: ({ providerID, providerOptions }) => {
    if (providerID === "minimax-cn-coding-plan") return 100;
    return isMiniMaxCodingBaseURL(providerOptions?.baseURL) ? 95 : 0;
  },
  isEnabled: (config) =>
    configuredProviderEnabled(config.quota, "minimax-cn-coding-plan", true),
  fetch: fetchMiniMaxCodingPlanQuota,
};
