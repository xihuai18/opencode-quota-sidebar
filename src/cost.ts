import type { AssistantMessage } from "@opencode-ai/sdk";

import { asNumber, isRecord } from "./helpers.js";
import type { OpenCodePricingModel } from "./opencode_pricing.js";
import type { CacheCoverageMode } from "./types.js";

export const API_COST_ENABLED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "kimi-for-coding",
  "zhipu",
  "minimax-cn-coding-plan",
]);

export const API_COST_RULES_VERSION = 2;

const MODEL_COST_STANDARD_UNIT = 1_000_000;
const MODEL_COST_RATE_UNIT_THRESHOLD = 0.001;
const OPENAI_FAST_COST_MULTIPLIER = 2;
const ANTHROPIC_FAST_COST_MULTIPLIER = 6;

export type CanonicalPriceSource = "official-doc" | "runtime";

const MODEL_COST_RATE_ALIASES: Record<string, string[]> = {
  "zhipuai-coding-plan:glm-5.1": ["zhipu:glm-5"],
  "zhipuai-coding-plan:glm-5.1-thinking": ["zhipu:glm-5"],
  "zhipu:glm-5.1": ["zhipu:glm-5"],
  "zhipu:glm-5.1-thinking": ["zhipu:glm-5"],
};

function moonshotCanonicalModelID(modelID: string) {
  const stripped = modelID.replace(/^moonshotai[/:]/i, "");
  switch (stripped) {
    case "k2p5":
    case "kimi-k2-5":
      return "kimi-k2.5";
    default:
      return stripped;
  }
}

function moonshotModelAliases(
  modelID: string,
  options?: { canonicalProviderKeys?: boolean },
) {
  const aliases: string[] = [];

  const push = (value: string) => {
    if (!value) return;
    if (!aliases.includes(value)) aliases.push(value);
  };

  const stripped = modelID.replace(/^moonshotai[/:]/i, "");
  const canonical = moonshotCanonicalModelID(modelID);

  if (!options?.canonicalProviderKeys) push(modelID);
  if (stripped !== modelID) push(stripped);
  push(canonical);

  return aliases;
}

function minimaxModelAliases(modelID: string) {
  const aliases: string[] = [];

  const push = (value: string) => {
    if (!value) return;
    if (!aliases.includes(value)) aliases.push(value);
  };

  push(modelID);
  push(modelID.toLowerCase());

  const stripped = modelID.replace(
    /^(?:minimax|minimax-cn-coding-plan)[/:]/i,
    "",
  );
  push(stripped);
  push(stripped.toLowerCase());

  if (/^minimax-/i.test(stripped)) {
    const suffix = stripped.slice("minimax-".length);
    push(`MiniMax-${suffix}`);
    push(`minimax-${suffix.toLowerCase()}`);
  }

  if (/^m2(?:[.-]\d+)?(?:-highspeed)?$/i.test(stripped)) {
    push(`MiniMax-${stripped}`);
    push(`minimax-${stripped.toLowerCase()}`);
  }

  return aliases;
}

function zhipuModelAliases(modelID: string) {
  const aliases: string[] = [];
  const queue: string[] = [];

  const push = (value: string) => {
    if (!value) return;
    if (!aliases.includes(value)) {
      aliases.push(value);
      queue.push(value);
    }
  };

  push(modelID);

  for (let index = 0; index < queue.length; index++) {
    const stem = queue[index];
    const withoutProviderPrefix = stem.replace(
      /^(?:zhipu|z-ai|bigmodel|zhipuai-coding-plan)[/:]/,
      "",
    );
    push(withoutProviderPrefix);
    push(`zhipu/${withoutProviderPrefix}`);

    const withoutBillingSuffix = withoutProviderPrefix.replace(/-billing$/, "");
    push(withoutBillingSuffix);
    push(`zhipu/${withoutBillingSuffix}`);

    const withoutThinkingSuffix = withoutBillingSuffix.replace(
      /-thinking$/,
      "",
    );
    push(withoutThinkingSuffix);
    push(`zhipu/${withoutThinkingSuffix}`);

    const dotted = withoutThinkingSuffix.replace(/(\d)-(\d)(?=-|$)/g, "$1.$2");
    push(dotted);
    push(`zhipu/${dotted}`);

    const hyphenated = withoutThinkingSuffix.replace(
      /(\d)\.(\d)(?=-|$)/g,
      "$1-$2",
    );
    push(hyphenated);
    push(`zhipu/${hyphenated}`);
  }

  return aliases;
}

function anthropicModelAliases(modelID: string) {
  const aliases: string[] = [];
  const queue: string[] = [];

  const push = (value: string) => {
    if (!value) return;
    if (!aliases.includes(value)) {
      aliases.push(value);
      queue.push(value);
    }
  };

  push(modelID);

  for (let index = 0; index < queue.length; index++) {
    const stem = queue[index];

    const withoutProviderPrefix = stem
      .replace(/^(?:[a-z]+\.)*anthropic\./, "")
      .replace(/^anthropic[/.]/, "");
    push(withoutProviderPrefix);
    push(`anthropic/${withoutProviderPrefix}`);

    const withoutVersionSuffix = withoutProviderPrefix.replace(
      /-v\d+(?::\d+)?$/,
      "",
    );
    push(withoutVersionSuffix);
    push(`anthropic/${withoutVersionSuffix}`);

    const atDate = withoutVersionSuffix.replace(/@(\d{8})$/, "-$1");
    push(atDate);
    push(`anthropic/${atDate}`);

    const withAtDate = withoutVersionSuffix.replace(/-(\d{8})$/, "@$1");
    push(withAtDate);
    push(`anthropic/${withAtDate}`);

    const withoutThinkingSuffix = withoutVersionSuffix.replace(
      /-thinking$/,
      "",
    );
    push(withoutThinkingSuffix);
    push(`anthropic/${withoutThinkingSuffix}`);

    const withoutLatestSuffix = withoutThinkingSuffix.replace(/-latest$/, "");
    push(withoutLatestSuffix);
    push(`anthropic/${withoutLatestSuffix}`);

    const withoutDateSuffix = withoutLatestSuffix
      .replace(/-\d{8}$/, "")
      .replace(/@\d{8}$/, "");
    push(withoutDateSuffix);
    push(`anthropic/${withoutDateSuffix}`);

    const dotted = withoutDateSuffix.replace(/(\d)-(\d)(?=-|$)/g, "$1.$2");
    push(dotted);
    push(`anthropic/${dotted}`);

    const hyphenated = withoutDateSuffix.replace(/(\d)\.(\d)(?=-|$)/g, "$1-$2");
    push(hyphenated);
    push(`anthropic/${hyphenated}`);
  }

  return aliases;
}

function normalizeKnownProviderID(providerID: string) {
  if (providerID.toLowerCase().startsWith("github-copilot")) {
    return "github-copilot";
  }
  return providerID;
}

function isOpenAICompatibleProviderID(providerID: string) {
  return (
    providerID === "openai" ||
    providerID.startsWith("openai-") ||
    providerID.endsWith("-openai") ||
    providerID.startsWith("openai/") ||
    providerID.endsWith("/openai") ||
    providerID.includes(".openai.") ||
    providerID.endsWith("-oai")
  );
}

function isAnthropicCompatibleProviderID(providerID: string) {
  return (
    providerID === "anthropic" ||
    providerID === "claude" ||
    providerID.startsWith("anthropic-") ||
    providerID.endsWith("-anthropic") ||
    providerID.startsWith("anthropic/") ||
    providerID.endsWith("/anthropic") ||
    providerID.includes(".anthropic.") ||
    providerID.startsWith("claude-") ||
    providerID.endsWith("-claude")
  );
}

function isCanonicalZhipuProviderID(providerID: string) {
  return (
    providerID === "zhipu" ||
    providerID === "bigmodel" ||
    providerID === "z-ai" ||
    providerID === "zhipuai-coding-plan"
  );
}

function isCanonicalMiniMaxProviderID(providerID: string) {
  return providerID === "minimax" || providerID === "minimax-cn-coding-plan";
}

export function canonicalPricingProviderID(providerID: string) {
  const normalized = normalizeKnownProviderID(providerID);
  const lowered = normalized.toLowerCase();

  if (isCanonicalMiniMaxProviderID(lowered)) {
    return "minimax";
  }
  if (isCanonicalZhipuProviderID(lowered)) {
    return "zhipu";
  }
  if (lowered === "kimi-for-coding") return "moonshotai";
  if (isAnthropicCompatibleProviderID(lowered)) {
    return "anthropic";
  }
  if (isOpenAICompatibleProviderID(lowered)) return "openai";
  if (lowered.includes("copilot")) return "github-copilot";
  return normalized;
}

export function canonicalApiCostProviderID(providerID: string) {
  const normalized = normalizeKnownProviderID(providerID);
  const lowered = normalized.toLowerCase();
  if (API_COST_ENABLED_PROVIDERS.has(lowered)) return lowered;

  if (lowered === "minimax") return "minimax-cn-coding-plan";
  if (lowered.includes("copilot")) return "github-copilot";
  if (isOpenAICompatibleProviderID(lowered)) return "openai";
  if (isAnthropicCompatibleProviderID(lowered)) {
    return "anthropic";
  }
  if (isCanonicalZhipuProviderID(lowered)) {
    return "zhipu";
  }
  return normalized;
}

export type ModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextOver200k?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export type CanonicalPriceEntry = {
  provider: string;
  model: string;
  rates: ModelCostRates;
  source: CanonicalPriceSource;
  sourceURL?: string;
  updatedAt?: string;
};

function anthropicPricing(
  input: number,
  output: number,
  options?: {
    longContextInput?: number;
    longContextOutput?: number;
  },
): ModelCostRates {
  // OpenCode currently reports zero Anthropic model prices in runtime metadata,
  // so keep a bundled fallback sourced from Anthropic's pricing docs.
  return {
    input,
    output,
    cacheRead: input * 0.1,
    // OpenCode only exposes aggregate cache.write tokens, so use Anthropic's
    // default 5-minute prompt-caching write rate.
    cacheWrite: input * 1.25,
    contextOver200k:
      options?.longContextInput !== undefined &&
      options?.longContextOutput !== undefined
        ? {
            input: options.longContextInput,
            output: options.longContextOutput,
            cacheRead: options.longContextInput * 0.1,
            cacheWrite: options.longContextInput * 1.25,
          }
        : undefined,
  };
}

function zhipuPricing(
  input: number,
  output: number,
  cacheRead: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  };
}

function moonshotPricing(
  input: number,
  output: number,
  cacheRead: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  };
}

function openaiPricing(
  input: number,
  output: number,
  cacheRead: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  };
}

function minimaxPricing(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): ModelCostRates {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

const BUNDLED_CANONICAL_PRICE_ENTRIES: CanonicalPriceEntry[] = [
  {
    provider: "openai",
    // OpenCode commonly reports the flagship alias as `gpt-5`; keep a bundled
    // fallback so API-equivalent cost still renders when runtime metadata omits
    // OpenAI pricing on a given client or subscription path.
    model: "gpt-5",
    rates: openaiPricing(2.5, 15, 0.25),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    model: "gpt-5.3",
    rates: openaiPricing(1.75, 14, 0.175),
    source: "official-doc",
    sourceURL:
      "https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest",
  },
  {
    provider: "openai",
    model: "gpt-5.3-chat-latest",
    rates: openaiPricing(1.75, 14, 0.175),
    source: "official-doc",
    sourceURL:
      "https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest",
  },
  {
    provider: "openai",
    model: "gpt-5.3-codex",
    rates: openaiPricing(1.75, 14, 0.175),
    source: "official-doc",
    sourceURL: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  },
  {
    provider: "openai",
    model: "gpt-5.2",
    rates: openaiPricing(1.75, 14, 0.175),
    source: "official-doc",
    sourceURL: "https://developers.openai.com/api/docs/models/gpt-5.2",
  },
  {
    provider: "openai",
    model: "gpt-5.2-chat-latest",
    rates: openaiPricing(1.75, 14, 0.175),
    source: "official-doc",
    sourceURL:
      "https://developers.openai.com/api/docs/models/gpt-5.2-chat-latest",
  },
  {
    provider: "openai",
    model: "gpt-5.2-pro",
    rates: openaiPricing(21, 168, 0),
    source: "official-doc",
    sourceURL: "https://openai.com/index/introducing-gpt-5-2/",
  },
  {
    provider: "openai",
    model: "gpt-5.4",
    rates: openaiPricing(2.5, 15, 0.25),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    rates: openaiPricing(0.75, 4.5, 0.075),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    rates: openaiPricing(0.75, 4.5, 0.075),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    model: "gpt-5-nano",
    rates: openaiPricing(0.2, 1.25, 0.02),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "openai",
    model: "gpt-5.4-nano",
    rates: openaiPricing(0.2, 1.25, 0.02),
    source: "official-doc",
    sourceURL: "https://openai.com/api/pricing/",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    rates: anthropicPricing(5, 25),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-5",
    rates: anthropicPricing(5, 25),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-1",
    rates: anthropicPricing(15, 75),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4",
    rates: anthropicPricing(15, 75),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    rates: anthropicPricing(3, 15),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    rates: anthropicPricing(3, 15, {
      longContextInput: 6,
      longContextOutput: 22.5,
    }),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    rates: anthropicPricing(3, 15, {
      longContextInput: 6,
      longContextOutput: 22.5,
    }),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    rates: anthropicPricing(3, 15),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    rates: anthropicPricing(3, 15),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    rates: anthropicPricing(1, 5),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-3-5-haiku",
    rates: anthropicPricing(0.8, 4),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-3-opus",
    rates: anthropicPricing(15, 75),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-3-haiku",
    rates: anthropicPricing(0.25, 1.25),
    source: "official-doc",
    sourceURL: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-5",
    rates: zhipuPricing(1, 3.2, 0.2),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.7",
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.6",
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.6v",
    rates: zhipuPricing(0.3, 0.9, 0.05),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.5",
    rates: zhipuPricing(0.6, 2.2, 0.11),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.5-air",
    rates: zhipuPricing(0.2, 1.1, 0.03),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "zhipu",
    model: "glm-4.5v",
    rates: zhipuPricing(0.6, 1.8, 0.11),
    source: "official-doc",
    sourceURL: "https://docs.z.ai/guides/overview/pricing",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2.5",
    rates: moonshotPricing(0.6, 3, 0.1),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2-thinking",
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2-0711-preview",
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2-0905-preview",
    rates: moonshotPricing(0.6, 2.5, 0.15),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2-turbo-preview",
    rates: moonshotPricing(2.4, 10, 0.6),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "moonshotai",
    model: "kimi-k2-thinking-turbo",
    rates: moonshotPricing(1.15, 8, 0.15),
    source: "official-doc",
    sourceURL: "https://platform.moonshot.ai/docs/pricing/chat",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.7",
    // OpenCode sources provider pricing from models.dev. The bundled MiniMax
    // fallback mirrors those USD-denominated entries rather than the CN RMB
    // docs so API-equivalent cost stays on the same currency basis as the rest
    // of the sidebar/report output.
    rates: minimaxPricing(0.3, 1.2, 0.06, 0.375),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.7.toml",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.7-highspeed",
    rates: minimaxPricing(0.6, 2.4, 0.06, 0.375),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.7-highspeed.toml",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.5",
    rates: minimaxPricing(0.3, 1.2, 0.03, 0.375),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.5.toml",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.5-highspeed",
    rates: minimaxPricing(0.6, 2.4, 0.06, 0.375),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.5-highspeed.toml",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.1",
    rates: minimaxPricing(0.3, 1.2, 0.03, 0.375),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.1.toml",
  },
  {
    provider: "minimax",
    model: "MiniMax-M2",
    rates: minimaxPricing(0.3, 1.2, 0, 0),
    source: "runtime",
    sourceURL:
      "https://github.com/anomalyco/models.dev/blob/dev/providers/minimax/models/MiniMax-M2.toml",
  },
];

export function modelCostKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function modelCostLookupKeys(providerID: string, modelID: string) {
  const keys: string[] = [];
  const canonicalProviderID = canonicalPricingProviderID(providerID);

  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };

  const modelIDsFor = (options?: { canonicalProviderKeys?: boolean }) =>
    canonicalProviderID === "anthropic"
      ? anthropicModelAliases(modelID)
      : canonicalProviderID === "zhipu"
        ? zhipuModelAliases(modelID)
        : canonicalProviderID === "moonshotai"
          ? moonshotModelAliases(modelID, options)
          : canonicalProviderID === "minimax"
            ? minimaxModelAliases(modelID)
            : [modelID];

  for (const candidateModelID of modelIDsFor()) {
    push(modelCostKey(providerID, candidateModelID));
  }

  if (canonicalProviderID !== providerID) {
    for (const candidateModelID of modelIDsFor({
      canonicalProviderKeys: true,
    })) {
      push(modelCostKey(canonicalProviderID, candidateModelID));
    }
  }

  for (const key of [...keys]) {
    for (const alias of MODEL_COST_RATE_ALIASES[key] || []) {
      push(alias);
    }
  }

  return keys;
}

function setLookupRates(
  map: Record<string, ModelCostRates>,
  providerID: string,
  modelID: string,
  rates: ModelCostRates,
  modelKey?: string,
) {
  const providerPrefix = `${providerID}:`;
  for (const key of modelCostLookupKeys(providerID, modelID)) {
    if (!key.startsWith(providerPrefix)) continue;
    map[key] = rates;
  }
  if (modelKey && modelKey !== modelID) {
    for (const key of modelCostLookupKeys(providerID, modelKey)) {
      if (!key.startsWith(providerPrefix)) continue;
      map[key] = rates;
    }
  }
}

function multiplyRates(
  rates: ModelCostRates,
  multiplier: number,
): ModelCostRates {
  return {
    input: rates.input * multiplier,
    output: rates.output * multiplier,
    cacheRead: rates.cacheRead * multiplier,
    cacheWrite: rates.cacheWrite * multiplier,
    // Fast/tier-derived pricing intentionally does not inherit the base model's
    // long-context tier. Those variants need their own explicit long-context
    // schedule instead of multiplying a different billing rule implicitly.
    contextOver200k: undefined,
  };
}

function apiBaseModelID(model: OpenCodePricingModel) {
  return isRecord(model.api) && typeof model.api.id === "string"
    ? model.api.id
    : undefined;
}

function headerValue(model: OpenCodePricingModel, key: string) {
  if (!isRecord(model.headers)) return undefined;
  const exact = model.headers[key];
  if (typeof exact === "string") return exact;

  const lowerKey = key.toLowerCase();
  for (const [headerKey, value] of Object.entries(model.headers)) {
    if (headerKey.toLowerCase() !== lowerKey) continue;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function heuristicFastBaseModelID(model: OpenCodePricingModel) {
  const canonicalProviderID = canonicalPricingProviderID(model.providerID);
  const candidates = [model.modelID, model.modelKey].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    if (canonicalProviderID === "openai") {
      const base = candidate.replace(/(?:[-/:](?:fast|priority))$/i, "");
      if (base !== candidate) return base;
    }
    if (canonicalProviderID === "anthropic") {
      const base = candidate.replace(/-fast$/i, "");
      if (base !== candidate) return base;
    }
  }

  return undefined;
}

function resolveSourceBaseRates(
  explicitRates: Record<string, ModelCostRates>,
  providerID: string,
  modelID: string,
) {
  return modelCostLookupKeys(providerID, modelID)
    .map((key) => explicitRates[key])
    .find(Boolean);
}

function isStructuredOpenAIFastModel(model: OpenCodePricingModel) {
  return (
    canonicalPricingProviderID(model.providerID) === "openai" &&
    isRecord(model.options) &&
    model.options.serviceTier === "priority"
  );
}

function isStructuredAnthropicFastModel(model: OpenCodePricingModel) {
  return (
    canonicalPricingProviderID(model.providerID) === "anthropic" &&
    ((isRecord(model.options) && model.options.speed === "fast") ||
      /\bfast\b/i.test(headerValue(model, "anthropic-beta") || ""))
  );
}

export function derivedTierBaseModelID(model: OpenCodePricingModel) {
  const canonicalProviderID = canonicalPricingProviderID(model.providerID);

  if (canonicalProviderID === "openai") {
    return (
      (isStructuredOpenAIFastModel(model)
        ? apiBaseModelID(model)
        : undefined) || heuristicFastBaseModelID(model)
    );
  }

  if (canonicalProviderID === "anthropic") {
    return (
      (isStructuredAnthropicFastModel(model)
        ? apiBaseModelID(model)
        : undefined) || heuristicFastBaseModelID(model)
    );
  }

  return undefined;
}

function derivedTierRatesForModel(
  model: OpenCodePricingModel,
  explicitRates: Record<string, ModelCostRates>,
) {
  const canonicalProviderID = canonicalPricingProviderID(model.providerID);
  const baseModelID = derivedTierBaseModelID(model);
  if (!baseModelID) return undefined;

  const baseRates = resolveSourceBaseRates(
    explicitRates,
    model.providerID,
    baseModelID,
  );
  if (!baseRates) return undefined;

  if (canonicalProviderID === "openai") {
    return multiplyRates(baseRates, OPENAI_FAST_COST_MULTIPLIER);
  }

  if (canonicalProviderID === "anthropic") {
    return multiplyRates(baseRates, ANTHROPIC_FAST_COST_MULTIPLIER);
  }

  return undefined;
}

export function explicitModelCostMap(models: OpenCodePricingModel[]) {
  const explicitRates: Record<string, ModelCostRates> = {};

  for (const model of models) {
    const rates = parseModelCostRates(model.cost);
    if (!rates) continue;
    setLookupRates(
      explicitRates,
      model.providerID,
      model.modelID,
      rates,
      model.modelKey,
    );
  }

  return explicitRates;
}

function hasExplicitModelCost(
  model: OpenCodePricingModel,
  explicitRates: Record<string, ModelCostRates>,
) {
  return [model.modelID, model.modelKey]
    .filter((value): value is string => Boolean(value))
    .some((candidate) =>
      modelCostLookupKeys(model.providerID, candidate).some((key) =>
        Boolean(explicitRates[key]),
      ),
    );
}

export function applyDerivedTierRatesFromSource(
  baseMap: Record<string, ModelCostRates>,
  metadataModels: OpenCodePricingModel[],
  sourceRates: Record<string, ModelCostRates>,
  options?: { skipExplicitRates?: Record<string, ModelCostRates> },
) {
  const nextMap = { ...baseMap };

  for (const model of metadataModels) {
    if (
      options?.skipExplicitRates &&
      hasExplicitModelCost(model, options.skipExplicitRates)
    ) {
      continue;
    }
    const derivedRates = derivedTierRatesForModel(model, sourceRates);
    if (!derivedRates) continue;
    setLookupRates(
      nextMap,
      model.providerID,
      model.modelID,
      derivedRates,
      model.modelKey,
    );
  }

  return nextMap;
}

export function applyExplicitRatesFromSource(
  baseMap: Record<string, ModelCostRates>,
  metadataModels: OpenCodePricingModel[],
  sourceRates: Record<string, ModelCostRates>,
  options?: { skipExplicitRates?: Record<string, ModelCostRates> },
) {
  const nextMap = { ...baseMap };

  for (const model of metadataModels) {
    if (
      options?.skipExplicitRates &&
      hasExplicitModelCost(model, options.skipExplicitRates)
    ) {
      continue;
    }

    const explicitRates = [model.modelID, model.modelKey]
      .filter((value): value is string => Boolean(value))
      .flatMap((candidate) => modelCostLookupKeys(model.providerID, candidate))
      .map((key) => sourceRates[key])
      .find(Boolean);
    if (!explicitRates) continue;

    setLookupRates(
      nextMap,
      model.providerID,
      model.modelID,
      explicitRates,
      model.modelKey,
    );
  }

  return nextMap;
}

export function mergeModelCostSource(
  baseMap: Record<string, ModelCostRates>,
  models: OpenCodePricingModel[],
) {
  const nextMap = { ...baseMap };
  const explicitRates = explicitModelCostMap(models);
  const explicitEntries: Array<{
    providerID: string;
    modelID: string;
    modelKey?: string;
    rates: ModelCostRates;
  }> = [];

  for (const model of models) {
    const rates = modelCostLookupKeys(model.providerID, model.modelID)
      .map((key) => explicitRates[key])
      .find(Boolean);
    if (!rates) continue;
    explicitEntries.push({
      providerID: model.providerID,
      modelID: model.modelID,
      modelKey: model.modelKey,
      rates,
    });
  }

  for (const model of models) {
    const derivedRates = derivedTierRatesForModel(model, explicitRates);
    if (!derivedRates) continue;
    setLookupRates(
      nextMap,
      model.providerID,
      model.modelID,
      derivedRates,
      model.modelKey,
    );
  }

  for (const entry of explicitEntries) {
    setLookupRates(
      nextMap,
      entry.providerID,
      entry.modelID,
      entry.rates,
      entry.modelKey,
    );
  }

  return nextMap;
}

function createBundledModelCostMap() {
  const map: Record<string, ModelCostRates> = {};

  for (const entry of BUNDLED_CANONICAL_PRICE_ENTRIES) {
    for (const key of modelCostLookupKeys(entry.provider, entry.model)) {
      map[key] = entry.rates;
    }
  }

  return map;
}

const BUNDLED_MODEL_COST_MAP = createBundledModelCostMap();

export function getBundledModelCostMap() {
  return { ...BUNDLED_MODEL_COST_MAP };
}

export function getBundledCanonicalPriceEntries() {
  return BUNDLED_CANONICAL_PRICE_ENTRIES.map((entry) => ({
    ...entry,
    rates: {
      ...entry.rates,
      contextOver200k: entry.rates.contextOver200k
        ? { ...entry.rates.contextOver200k }
        : undefined,
    },
  }));
}

function normalizeRateToPerMillion(input: number) {
  if (!Number.isFinite(input) || input <= 0) return 0;
  return input > MODEL_COST_RATE_UNIT_THRESHOLD
    ? input
    : input * MODEL_COST_STANDARD_UNIT;
}

export function normalizeModelCostRates(rates: ModelCostRates): ModelCostRates {
  return {
    input: normalizeRateToPerMillion(rates.input),
    output: normalizeRateToPerMillion(rates.output),
    cacheRead: normalizeRateToPerMillion(rates.cacheRead),
    cacheWrite: normalizeRateToPerMillion(rates.cacheWrite),
    contextOver200k: rates.contextOver200k
      ? {
          input: normalizeRateToPerMillion(rates.contextOver200k.input),
          output: normalizeRateToPerMillion(rates.contextOver200k.output),
          cacheRead: normalizeRateToPerMillion(rates.contextOver200k.cacheRead),
          cacheWrite: normalizeRateToPerMillion(
            rates.contextOver200k.cacheWrite,
          ),
        }
      : undefined,
  };
}

export function parseModelCostRates(
  value: unknown,
): ModelCostRates | undefined {
  if (!isRecord(value)) return undefined;

  const readRate = (input: unknown) => {
    if (typeof input === "number") return normalizeRateToPerMillion(input);
    if (typeof input === "string") {
      const parsed = Number(input);
      return Number.isFinite(parsed) ? normalizeRateToPerMillion(parsed) : 0;
    }
    if (isRecord(input)) {
      const perMillion =
        asNumber(input.per_1m) ?? asNumber(input.per1m) ?? undefined;
      if (perMillion !== undefined) return Math.max(0, perMillion);

      const perToken =
        asNumber(input.per_token) ?? asNumber(input.perToken) ?? undefined;
      if (perToken !== undefined) {
        return Math.max(0, perToken) * MODEL_COST_STANDARD_UNIT;
      }

      return normalizeRateToPerMillion(
        asNumber(input.usd, asNumber(input.value, 0)),
      );
    }
    return 0;
  };

  const cache = isRecord(value.cache) ? value.cache : undefined;
  const input = readRate(value.input ?? value.prompt);
  const output = readRate(value.output ?? value.completion);
  const cacheRead = readRate(value.cache_read ?? cache?.read);
  const cacheWrite = readRate(value.cache_write ?? cache?.write);
  const contextOver200k = isRecord(value.context_over_200k)
    ? {
        input: readRate(value.context_over_200k.input),
        output: readRate(value.context_over_200k.output),
        cacheRead: readRate(value.context_over_200k.cache_read),
        cacheWrite: readRate(value.context_over_200k.cache_write),
      }
    : undefined;

  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) {
    return undefined;
  }

  const hasContextTier =
    !!contextOver200k &&
    (contextOver200k.input > 0 ||
      contextOver200k.output > 0 ||
      contextOver200k.cacheRead > 0 ||
      contextOver200k.cacheWrite > 0);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    contextOver200k: hasContextTier ? contextOver200k : undefined,
  };
}

export function cacheCoverageModeFromRates(
  rates: ModelCostRates | undefined,
): CacheCoverageMode {
  if (!rates) return "none";

  if (rates.cacheWrite > 0) return "read-write";
  if (rates.cacheRead > 0) return "read-only";
  return "none";
}

export function calcEquivalentApiCostForMessage(
  message: AssistantMessage,
  rates: ModelCostRates,
) {
  const effectiveRates =
    // Long-context tiering intentionally keys off live input tokens only.
    // Cached read tokens do not promote the request into the >200k tier.
    message.tokens.input > 200_000 && rates.contextOver200k
      ? rates.contextOver200k
      : rates;

  // For providers that expose reasoning tokens separately, they are still
  // billed as output/completion tokens (same unit price). Our UI also merges
  // reasoning into the single Output statistic, so API cost should match that.
  const billedOutput = message.tokens.output + message.tokens.reasoning;
  const rawCost =
    message.tokens.input * effectiveRates.input +
    billedOutput * effectiveRates.output +
    message.tokens.cache.read * effectiveRates.cacheRead +
    message.tokens.cache.write * effectiveRates.cacheWrite;

  const normalized = rawCost / MODEL_COST_STANDARD_UNIT;
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}
