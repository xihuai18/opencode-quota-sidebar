import { isRecord, swallow } from "../../helpers.js";
import type { QuotaSnapshot } from "../../types.js";
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

function isBuzzBaseURL(value: unknown) {
  const normalized = sanitizeBaseURL(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") return false;
    return parsed.host === "buzzai.cc" || parsed.host === "www.buzzai.cc";
  } catch {
    return false;
  }
}

function dashboardUrl(baseURL: unknown, pathname: string) {
  const normalized = sanitizeBaseURL(baseURL);
  if (normalized) {
    try {
      return new URL(pathname, normalized).toString();
    } catch {
      // Fall through to the stable default host below.
    }
  }
  return `https://buzzai.cc${pathname}`;
}

async function fetchBuzzQuota({
  sourceProviderID,
  providerID,
  providerOptions,
  auth,
  config,
}: QuotaFetchContext): Promise<QuotaSnapshot> {
  const checkedAt = Date.now();
  const runtimeProviderID =
    typeof sourceProviderID === "string" && sourceProviderID
      ? sourceProviderID
      : providerID;

  const base: Pick<
    QuotaSnapshot,
    "providerID" | "adapterID" | "label" | "shortLabel" | "sortOrder"
  > = {
    providerID: runtimeProviderID,
    adapterID: "buzz",
    label: "Buzz",
    shortLabel: "Buzz",
    sortOrder: 6,
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

  const subscriptionEndpoint = dashboardUrl(
    providerOptions?.baseURL,
    "/v1/dashboard/billing/subscription",
  );
  const usageEndpoint = dashboardUrl(
    providerOptions?.baseURL,
    "/v1/dashboard/billing/usage",
  );

  const requestInit = {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "opencode-quota-sidebar",
    },
  };

  const [subscriptionResponse, usageResponse] = await Promise.all([
    fetchWithTimeout(
      subscriptionEndpoint,
      requestInit,
      config.quota.requestTimeoutMs,
    ).catch(swallow("fetchBuzzQuota:subscription")),
    fetchWithTimeout(
      usageEndpoint,
      requestInit,
      config.quota.requestTimeoutMs,
    ).catch(swallow("fetchBuzzQuota:usage")),
  ]);

  if (!subscriptionResponse || !usageResponse) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "network request failed",
    };
  }

  if (!subscriptionResponse.ok || !usageResponse.ok) {
    const note = [
      !subscriptionResponse.ok
        ? `subscription http ${subscriptionResponse.status}`
        : undefined,
      !usageResponse.ok ? `usage http ${usageResponse.status}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(", ");

    return {
      ...base,
      status: "error",
      checkedAt,
      note,
    };
  }

  const [subscriptionPayload, usagePayload] = await Promise.all([
    subscriptionResponse
      .json()
      .catch(swallow("fetchBuzzQuota:subscriptionJson")),
    usageResponse.json().catch(swallow("fetchBuzzQuota:usageJson")),
  ]);

  if (!isRecord(subscriptionPayload) || !isRecord(usagePayload)) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "invalid response",
    };
  }

  const totalQuota = asNumber(subscriptionPayload.soft_limit_usd);
  const totalUsage = asNumber(usagePayload.total_usage);
  if (totalQuota === undefined || totalUsage === undefined) {
    return {
      ...base,
      status: "error",
      checkedAt,
      note: "missing billing fields",
    };
  }

  const accessUntil = asNumber(subscriptionPayload.access_until);
  const resetAt =
    accessUntil !== undefined && accessUntil > 0
      ? toIso(accessUntil)
      : undefined;
  const balance = totalQuota - totalUsage / 100;

  return {
    ...base,
    status: "ok",
    checkedAt,
    resetAt,
    balance: {
      amount: balance,
      currency: "$",
    },
    note: "remaining balance = soft_limit_usd - total_usage / 100",
  };
}

export const buzzAdapter: QuotaProviderAdapter = {
  id: "buzz",
  label: "Buzz",
  shortLabel: "Buzz",
  sortOrder: 6,
  matchScore: ({ providerOptions }) =>
    isBuzzBaseURL(providerOptions?.baseURL) ? 100 : 0,
  isEnabled: (config) => configuredProviderEnabled(config.quota, "buzz", true),
  fetch: fetchBuzzQuota,
};
