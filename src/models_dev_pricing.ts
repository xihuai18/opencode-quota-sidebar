import { debug, mapConcurrent } from "./helpers.js";
import {
  canonicalPricingProviderID,
  modelCostLookupKeys,
  type ModelCostRates,
} from "./cost.js";
import type { OpenCodePricingModel } from "./opencode_pricing.js";

const MODELS_DEV_RAW_BASE_URL =
  "https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers";
const MODELS_DEV_TIMEOUT_MS = 10_000;
const MODELS_DEV_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
const MODELS_DEV_NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MODELS_DEV_PARSE_MISS_TTL_MS = 10 * 60 * 1000;
const MODELS_DEV_REQUEST_CONCURRENCY = 4;

const fileCache = new Map<
  string,
  { expiresAt: number; cost: OpenCodePricingModel["cost"] | null }
>();

function modelsDevProviderDirs(providerID: string) {
  const canonical = canonicalPricingProviderID(providerID);

  if (canonical === "openai") return ["openai"];
  if (canonical === "anthropic") return ["anthropic"];
  if (canonical === "moonshotai") return ["moonshotai", "kimi-for-coding"];
  if (canonical === "minimax") {
    return ["minimax-cn-coding-plan", "minimax-coding-plan", "minimax"];
  }
  if (canonical === "zhipu") {
    return ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"];
  }

  return [] as string[];
}

function stripInlineComment(line: string) {
  let inString = false;
  let escaping = false;
  let output = "";

  for (const char of line) {
    if (char === '"' && !escaping) inString = !inString;
    if (char === "#" && !inString) break;
    output += char;
    if (escaping) {
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    }
  }

  return output.trim();
}

function parseTomlNumber(raw: string) {
  const parsed = Number(raw.replace(/_/g, "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseModelsDevCost(
  text: string,
): OpenCodePricingModel["cost"] | undefined {
  const rates: Record<string, number> = {};
  const contextRates: Record<string, number> = {};
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] || "";
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = parseTomlNumber(kvMatch[2] || "");
    if (value === undefined) continue;

    if (section === "cost") {
      rates[key] = value;
      continue;
    }
    if (section === "cost.context_over_200k") {
      contextRates[key] = value;
    }
  }

  const hasBase =
    (rates.input || 0) > 0 ||
    (rates.output || 0) > 0 ||
    (rates.cache_read || 0) > 0 ||
    (rates.cache_write || 0) > 0;
  if (!hasBase) return undefined;

  const hasContext =
    (contextRates.input || 0) > 0 ||
    (contextRates.output || 0) > 0 ||
    (contextRates.cache_read || 0) > 0 ||
    (contextRates.cache_write || 0) > 0;

  return {
    input: rates.input || 0,
    output: rates.output || 0,
    cache_read: rates.cache_read || 0,
    cache_write: rates.cache_write || 0,
    ...(hasContext
      ? {
          context_over_200k: {
            input: contextRates.input || 0,
            output: contextRates.output || 0,
            cache_read: contextRates.cache_read || 0,
            cache_write: contextRates.cache_write || 0,
          },
        }
      : {}),
  };
}

function modelsDevModelCandidates(model: OpenCodePricingModel) {
  const candidates = new Set<string>();

  for (const stem of [model.modelID, model.modelKey].filter(
    (value): value is string => Boolean(value),
  )) {
    for (const key of modelCostLookupKeys(model.providerID, stem)) {
      const separator = key.indexOf(":");
      const candidate = separator >= 0 ? key.slice(separator + 1) : key;
      if (!candidate || candidate.includes("/")) continue;
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

async function fetchModelsDevCost(url: string) {
  const cached = fileCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.cost;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
  (timeout as { unref?: () => void }).unref?.();

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) {
      fileCache.set(url, {
        expiresAt: Date.now() + MODELS_DEV_NEGATIVE_TTL_MS,
        cost: null,
      });
      return null;
    }
    if (!response.ok) {
      debug(`models.dev fetch failed ${response.status} for ${url}`);
      return undefined;
    }

    const parsed = parseModelsDevCost(await response.text());
    fileCache.set(url, {
      expiresAt:
        Date.now() +
        (parsed ? MODELS_DEV_POSITIVE_TTL_MS : MODELS_DEV_PARSE_MISS_TTL_MS),
      cost: parsed || null,
    });
    return parsed || null;
  } catch (error) {
    debug(`models.dev fetch error for ${url}: ${String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function modelsDevHasProvider(providerID: string) {
  return modelsDevProviderDirs(providerID).length > 0;
}

export async function loadModelsDevPricingModels(
  requests: OpenCodePricingModel[],
) {
  const resolved = new Map<string, OpenCodePricingModel>();
  const entries = await mapConcurrent(
    requests,
    MODELS_DEV_REQUEST_CONCURRENCY,
    async (request) => {
      const dirs = modelsDevProviderDirs(request.providerID);
      if (dirs.length === 0) return undefined;
      const candidates = modelsDevModelCandidates(request);
      if (candidates.length === 0) return undefined;

      let found: OpenCodePricingModel["cost"] | undefined | null = undefined;

      for (const dir of dirs) {
        for (const candidate of candidates) {
          const url = `${MODELS_DEV_RAW_BASE_URL}/${dir}/models/${candidate}.toml`;
          const cost = await fetchModelsDevCost(url);
          if (cost === undefined || cost === null) continue;
          found = cost;
          break;
        }
        if (found) break;
      }

      if (!found) return undefined;
      return {
        key: `${request.providerID}:${request.modelID}`,
        model: {
          providerKey: request.providerKey,
          providerID: request.providerID,
          modelID: request.modelID,
          modelKey: request.modelKey,
          cost: found,
          options: request.options,
          headers: request.headers,
          api: request.api,
          limit: request.limit,
        } satisfies OpenCodePricingModel,
      };
    },
  );

  for (const entry of entries) {
    if (!entry) continue;
    resolved.set(entry.key, entry.model);
  }

  return [...resolved.values()];
}

export function clearModelsDevPricingCache() {
  fileCache.clear();
}

export function modelsDevCostToRates(
  cost: OpenCodePricingModel["cost"],
): ModelCostRates | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const record = cost as Record<string, unknown>;
  const context =
    record.context_over_200k && typeof record.context_over_200k === "object"
      ? (record.context_over_200k as Record<string, unknown>)
      : undefined;
  return {
    input: Number(record.input || 0),
    output: Number(record.output || 0),
    cacheRead: Number(record.cache_read || 0),
    cacheWrite: Number(record.cache_write || 0),
    contextOver200k: context
      ? {
          input: Number(context.input || 0),
          output: Number(context.output || 0),
          cacheRead: Number(context.cache_read || 0),
          cacheWrite: Number(context.cache_write || 0),
        }
      : undefined,
  };
}
