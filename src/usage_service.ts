import type { AssistantMessage, Message } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

import { TtlValueCache } from "./cache.js";
import {
  applyExplicitRatesFromSource,
  applyDerivedTierRatesFromSource,
  API_COST_RULES_VERSION,
  cacheCoverageModeFromRates,
  calcEquivalentApiCostForMessage,
  canonicalApiCostProviderID,
  canonicalPricingProviderID,
  derivedTierBaseModelID,
  explicitModelCostMap,
  getBundledModelCostMap,
  mergeModelCostSource,
  modelCostLookupKeys,
  modelCostKey,
  parseModelCostRates,
  type ModelCostRates,
} from "./cost.js";
import {
  deleteSessionFromDayChunk,
  dateKeyFromTimestamp,
  scanAllSessions,
  updateSessionsInDayChunks,
} from "./storage.js";
import { periodStart, type HistoryPeriod } from "./period.js";
import {
  debug,
  debugError,
  isRecord,
  mapConcurrent,
  swallow,
} from "./helpers.js";
import {
  accumulateMessagesAcrossCompletedRanges,
  accumulateMessagesInCompletedRange,
  emptyUsageSummary,
  fromCachedSessionUsage,
  mergeCursorFromEntries,
  mergeUsage,
  summarizeMessagesAcrossCompletedRanges,
  summarizeMessagesInCompletedRange,
  summarizeMessagesIncremental,
  toCachedSessionUsage,
  USAGE_BILLING_CACHE_VERSION,
  type UsageSummary,
} from "./usage.js";
import {
  decodeMessageEntries,
  isMissingSessionError,
  nextCursorFromResponse,
} from "./history_messages.js";
import { computeHistoryUsage } from "./history_usage.js";
import {
  loadModelsDevPricingModels,
  modelsDevHasProvider,
} from "./models_dev_pricing.js";
import {
  loadOpenCodePricingModels,
  type OpenCodePricingModel,
} from "./opencode_pricing.js";
import { opencodeConfigPaths } from "./storage_paths.js";

export type { HistoryUsageRow, HistoryUsageResult } from "./history_usage.js";
// Re-import locally for use in function signatures.
import type { HistoryUsageResult } from "./history_usage.js";

const READ_ONLY_CACHE_PROVIDERS = new Set([
  "openai",
  "github-copilot",
  "venice",
  "openrouter",
]);
import type {
  CachedSessionUsage,
  IncrementalCursor,
  QuotaSidebarConfig,
  QuotaSidebarState,
} from "./types.js";

type DescendantsResolver = {
  listDescendantSessionIDs: (
    sessionID: string,
    opts: { maxDepth: number; maxSessions: number; concurrency: number },
  ) => Promise<string[]>;
};

type Persistence = {
  markDirty: (dateKey: string | undefined) => void;
  scheduleSave: () => void;
  flushSave: () => Promise<void>;
};

export function createUsageService(deps: {
  state: QuotaSidebarState;
  config: QuotaSidebarConfig;
  statePath: string;
  client: PluginInput["client"];
  directory: string;
  worktree?: string;
  persistence: Persistence;
  descendantsResolver: DescendantsResolver;
}) {
  const forceRescanSessions = new Set<string>();
  const dirtyGeneration = new Map<string, number>();
  const cleanGeneration = new Map<string, number>();

  const bumpDirty = (sessionID: string) => {
    dirtyGeneration.set(sessionID, (dirtyGeneration.get(sessionID) || 0) + 1);
  };

  const isDirty = (sessionID: string) => {
    if (deps.state.sessions[sessionID]?.dirty) return true;
    return (
      (dirtyGeneration.get(sessionID) || 0) !==
      (cleanGeneration.get(sessionID) || 0)
    );
  };

  // Serialize per-session usage aggregation to avoid redundant message fetches
  // and cursor races when both a child session and its parent (includeChildren)
  // are refreshed concurrently.
  //
  // Track the generation the promise corresponds to; if new messages arrive
  // (generation bumps), callers should not reuse a stale in-flight computation.
  const usageInFlight = new Map<
    string,
    { generation: number; promise: Promise<SessionUsageResult> }
  >();

  const modelCostCache = new TtlValueCache<Record<string, ModelCostRates>>();
  let lastSuccessfulRuntimePricingLayer:
    | Record<string, ModelCostRates>
    | undefined;
  const missingApiCostRateKeys = new Set<string>();

  const collectModelsDevRequests = (
    models: OpenCodePricingModel[],
    currentMap: Record<string, ModelCostRates>,
  ) => {
    const requests = new Map<string, OpenCodePricingModel>();

    const enqueue = (model: OpenCodePricingModel) => {
      if (!modelsDevHasProvider(model.providerID)) return;
      requests.set(`${model.providerID}:${model.modelID}`, model);
    };

    const hasRates = (providerID: string, modelID: string) =>
      modelCostLookupKeys(providerID, modelID).some((key) =>
        Boolean(currentMap[key]),
      );

    for (const model of models) {
      if (!hasRates(model.providerID, model.modelID)) enqueue(model);

      const baseModelID = derivedTierBaseModelID(model);
      if (!baseModelID || hasRates(model.providerID, baseModelID)) continue;
      enqueue({
        providerID: model.providerID,
        modelID: baseModelID,
      });
    }

    return [...requests.values()];
  };

  const runtimePricingModels = (providers: unknown[]) => {
    const models: OpenCodePricingModel[] = [];

    for (const provider of providers) {
      if (!isRecord(provider)) continue;
      const providerID =
        typeof provider.id === "string" ? provider.id : undefined;
      if (!providerID) continue;

      const providerModels = provider.models;
      if (!isRecord(providerModels)) continue;

      for (const [modelKey, modelValue] of Object.entries(providerModels)) {
        if (!isRecord(modelValue)) continue;
        const modelID =
          typeof modelValue.id === "string" ? modelValue.id : modelKey;
        models.push({
          providerID,
          modelID,
          modelKey,
          cost: modelValue.cost,
          options: isRecord(modelValue.options)
            ? modelValue.options
            : undefined,
          headers: isRecord(modelValue.headers)
            ? modelValue.headers
            : undefined,
          api: isRecord(modelValue.api) ? modelValue.api : undefined,
          limit: isRecord(modelValue.limit) ? modelValue.limit : undefined,
        });
      }
    }

    return models;
  };

  const getModelCostMap = async () => {
    const cached = modelCostCache.get();
    if (cached) return cached;

    const fallbackMap = getBundledModelCostMap();
    const configModels = await loadOpenCodePricingModels(
      opencodeConfigPaths(deps.worktree || deps.directory, deps.directory),
    );

    const providerClient = deps.client as unknown as {
      provider?: {
        list?: (args: {
          query: { directory: string };
          throwOnError: true;
        }) => Promise<unknown>;
      };
    };

    if (!providerClient.provider?.list) {
      return modelCostCache.set(
        mergeModelCostSource(fallbackMap, configModels),
        30_000,
      );
    }

    const response = await providerClient.provider
      .list({
        query: { directory: deps.directory },
        throwOnError: true,
      })
      .catch(swallow("getModelCostMap"));

    const hasRuntimeProviderList =
      response &&
      typeof response === "object" &&
      "data" in response &&
      isRecord(response.data) &&
      Array.isArray(response.data.all);
    const responseData =
      hasRuntimeProviderList &&
      response &&
      typeof response === "object" &&
      "data" in response
        ? (response.data as { all: unknown[] })
        : undefined;
    const runtimeModels =
      hasRuntimeProviderList && responseData
        ? runtimePricingModels(responseData.all)
        : [];
    const configAndBundledLayer = mergeModelCostSource(
      fallbackMap,
      configModels,
    );
    const runtimeExplicitRates = explicitModelCostMap(runtimeModels);
    const modelsDevModels = await loadModelsDevPricingModels(
      collectModelsDevRequests(runtimeModels, {
        ...configAndBundledLayer,
        ...runtimeExplicitRates,
      }),
    );
    const modelsDevLayer = mergeModelCostSource({}, modelsDevModels);
    const configExplicitRates = explicitModelCostMap(configModels);

    const runtimeBaseLayer =
      hasRuntimeProviderList && runtimeModels.length > 0
        ? mergeModelCostSource(
            lastSuccessfulRuntimePricingLayer || {},
            runtimeModels,
          )
        : lastSuccessfulRuntimePricingLayer || {};
    const runtimeLayer = applyDerivedTierRatesFromSource(
      runtimeBaseLayer,
      runtimeModels,
      {
        ...fallbackMap,
        ...modelsDevLayer,
        ...lastSuccessfulRuntimePricingLayer,
        ...runtimeExplicitRates,
      },
      { skipExplicitRates: runtimeExplicitRates },
    );
    if (hasRuntimeProviderList) {
      lastSuccessfulRuntimePricingLayer = runtimeLayer;
    }

    let map = {
      ...fallbackMap,
      ...modelsDevLayer,
      ...runtimeLayer,
    };
    map = applyExplicitRatesFromSource(map, runtimeModels, configExplicitRates);
    map = applyDerivedTierRatesFromSource(
      map,
      runtimeModels,
      configExplicitRates,
      { skipExplicitRates: configExplicitRates },
    );
    const merged = mergeModelCostSource(map, configModels);

    return modelCostCache.set(
      merged,
      Math.max(30_000, deps.config.quota.refreshMs),
    );
  };

  const pricingKeyForMessage = (message: AssistantMessage) =>
    `${message.providerID}:${message.modelID}`;

  const collectPricingKeys = (
    entries: MessageEntry[],
    target = new Set<string>(),
  ) => {
    for (const { info } of entries) {
      if (info.role !== "assistant") continue;
      target.add(pricingKeyForMessage(info));
    }
    return target;
  };

  const serializeRates = (rates: ModelCostRates | undefined) =>
    rates
      ? {
          input: rates.input,
          output: rates.output,
          cacheRead: rates.cacheRead,
          cacheWrite: rates.cacheWrite,
          contextOver200k: rates.contextOver200k
            ? {
                input: rates.contextOver200k.input,
                output: rates.contextOver200k.output,
                cacheRead: rates.contextOver200k.cacheRead,
                cacheWrite: rates.contextOver200k.cacheWrite,
              }
            : undefined,
        }
      : null;

  const pricingFingerprintForKeys = (
    pricingKeys: string[],
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    const normalized = Array.from(new Set(pricingKeys)).sort();
    return JSON.stringify({
      version: API_COST_RULES_VERSION,
      prices: normalized.map((pricingKey) => {
        const separator = pricingKey.indexOf(":");
        const providerID =
          separator >= 0 ? pricingKey.slice(0, separator) : pricingKey;
        const modelID = separator >= 0 ? pricingKey.slice(separator + 1) : "";
        const rates = modelCostLookupKeys(providerID, modelID)
          .map((key) => modelCostMap[key])
          .find(Boolean);
        return {
          providerID,
          modelID,
          rates: serializeRates(rates),
        };
      }),
    });
  };

  const pricingFingerprintForEntries = (
    entries: MessageEntry[],
    modelCostMap: Record<string, ModelCostRates>,
  ) =>
    pricingFingerprintForKeys(
      [...collectPricingKeys(entries)].sort(),
      modelCostMap,
    );

  const expectedPricingFingerprintForCached = (
    cached: CachedSessionUsage | undefined,
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    if (!cached?.pricingKeys) return undefined;
    return pricingFingerprintForKeys(cached.pricingKeys, modelCostMap);
  };

  const calcEquivalentApiCost = (
    message: AssistantMessage,
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    const providerID = canonicalApiCostProviderID(message.providerID);
    if (providerID === "github-copilot") return 0;

    const rates = modelCostLookupKeys(message.providerID, message.modelID)
      .map((key) => modelCostMap[key])
      .find(Boolean);
    if (!rates) {
      const key = modelCostKey(providerID, message.modelID);
      if (!missingApiCostRateKeys.has(key)) {
        missingApiCostRateKeys.add(key);
        debug(`apiCost skipped: no model price for ${key}`);
      }
      return 0;
    }

    return calcEquivalentApiCostForMessage(message, rates);
  };

  const classifyCacheMode = (
    message: AssistantMessage,
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    const canonicalProviderID = canonicalApiCostProviderID(message.providerID);
    const baseRates = modelCostLookupKeys(message.providerID, message.modelID)
      .map((key) => modelCostMap[key])
      .find(Boolean);
    const effectiveRates =
      baseRates && message.tokens.input > 200_000 && baseRates.contextOver200k
        ? baseRates.contextOver200k
        : baseRates;
    const fromRates = cacheCoverageModeFromRates(effectiveRates);
    if (fromRates !== "none") return fromRates;

    if (message.tokens.cache.write > 0) return "read-write";
    if (message.tokens.cache.read <= 0) return "none";

    const rawProviderID = message.providerID.toLowerCase();

    if (
      READ_ONLY_CACHE_PROVIDERS.has(canonicalProviderID) ||
      READ_ONLY_CACHE_PROVIDERS.has(rawProviderID)
    ) {
      return "read-only";
    }

    // Heuristic fallback: classify by provider identity when pricing is missing.
    if (
      canonicalProviderID === "anthropic" ||
      message.modelID.toLowerCase().includes("claude")
    ) {
      return "read-write";
    }

    // Last resort: if the message has cache.read tokens from an unknown provider,
    // treat it as read-only (the safer default — avoids overstating cached ratio).
    return "read-only";
  };

  type MessageEntry = { info: Message };
  type LoadSessionEntriesResult =
    | { status: "ok"; entries: MessageEntry[] }
    | { status: "missing" }
    | { status: "error" };
  type LoadSessionEntriesPageResult =
    | { status: "ok"; entries: MessageEntry[]; nextBefore?: string }
    | { status: "missing" }
    | { status: "error" };

  const loadSessionEntries = async (
    sessionID: string,
  ): Promise<LoadSessionEntriesResult> => {
    try {
      const response = await deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: deps.directory },
        throwOnError: true,
      });
      const data = (response as { data?: unknown }).data;
      const entries = decodeMessageEntries(data);
      if (!entries) return { status: "error" } as const;
      return { status: "ok", entries } as const;
    } catch (error) {
      debugError(`loadSessionEntries ${sessionID}`, error);
      return {
        status: isMissingSessionError(error) ? "missing" : "error",
      } as const;
    }
  };

  const MESSAGE_PAGE_LIMIT = 200;

  const loadSessionEntriesPage = async (
    sessionID: string,
    before?: string,
  ): Promise<LoadSessionEntriesPageResult> => {
    try {
      const response = await deps.client.session.messages({
        path: { id: sessionID },
        query: {
          directory: deps.directory,
          limit: MESSAGE_PAGE_LIMIT,
          ...(before ? { before } : {}),
        },
        throwOnError: true,
      });
      const data = (response as { data?: unknown }).data;
      const entries = decodeMessageEntries(data);
      if (!entries) return { status: "error" } as const;
      return {
        status: "ok",
        entries,
        nextBefore: nextCursorFromResponse(response),
      } as const;
    } catch (error) {
      debugError(`loadSessionEntriesPage ${sessionID}`, error);
      return {
        status: isMissingSessionError(error) ? "missing" : "error",
      } as const;
    }
  };

  const persistSessionUsage = (
    sessionID: string,
    usage: CachedSessionUsage,
  ) => {
    const sessionState = deps.state.sessions[sessionID];
    if (!sessionState) return;
    sessionState.usage = usage;
    const dateKey =
      deps.state.sessionDateMap[sessionID] ||
      dateKeyFromTimestamp(sessionState.createdAt);
    deps.state.sessionDateMap[sessionID] = dateKey;
    deps.persistence.markDirty(dateKey);
  };

  const isUsageBillingCurrent = (
    cached: CachedSessionUsage | undefined,
    pricingFingerprint: string | undefined,
  ) => {
    if (!cached || !pricingFingerprint) return false;
    if (cached.billingVersion !== USAGE_BILLING_CACHE_VERSION) return false;
    return cached.pricingFingerprint === pricingFingerprint;
  };

  const shouldRecomputeUsageCache = (
    cached: CachedSessionUsage,
    pricingFingerprint: string | undefined,
  ) => !isUsageBillingCurrent(cached, pricingFingerprint);

  const hasResolvableApiCostMessages = (
    entries: MessageEntry[],
    modelCostMap: Record<string, ModelCostRates>,
  ) => {
    return entries.some(({ info }) => {
      if (info.role !== "assistant") return false;
      const providerID = canonicalApiCostProviderID(info.providerID);
      if (providerID === "github-copilot") return false;
      return modelCostLookupKeys(info.providerID, info.modelID).some((key) =>
        Boolean(modelCostMap[key]),
      );
    });
  };

  const shouldTrackFullUsageForRange = (
    cached: CachedSessionUsage | undefined,
    modelCostMap: Record<string, unknown>,
  ) =>
    !isUsageBillingCurrent(
      cached,
      expectedPricingFingerprintForCached(
        cached,
        modelCostMap as Record<string, ModelCostRates>,
      ),
    );

  type SessionUsageResult = {
    usage: UsageSummary;
    persist: boolean;
    pricingFingerprint?: string;
    pricingKeys?: string[];
  };

  const summarizeSessionUsage = async (
    sessionID: string,
    generationAtStart: number,
    options?: { requireEntries?: boolean },
  ): Promise<SessionUsageResult> => {
    const load = await loadSessionEntries(sessionID);
    const entries = load.status === "ok" ? load.entries : undefined;
    const sessionState = deps.state.sessions[sessionID];

    // If we can't load messages (transient API failure), fall back to cached
    // usage if available and avoid mutating cursor/dirty state.
    if (!entries) {
      if (sessionState?.usage && sessionState.dirty !== true) {
        const modelCostMap = await getModelCostMap();
        const cachedPricingFingerprint = expectedPricingFingerprintForCached(
          sessionState.usage,
          modelCostMap,
        );
        if (
          isUsageBillingCurrent(sessionState.usage, cachedPricingFingerprint)
        ) {
          return {
            usage: fromCachedSessionUsage(sessionState.usage, 1),
            persist: false,
          };
        }
      }
      if (options?.requireEntries) {
        throw new Error(
          `session usage unavailable: failed to load messages for ${sessionID}`,
        );
      }
      const empty = emptyUsageSummary();
      empty.sessionCount = 1;
      return { usage: empty, persist: false };
    }

    const modelCostMap = await getModelCostMap();
    const pricingKeys = [...collectPricingKeys(entries)].sort();
    const pricingFingerprint = pricingFingerprintForEntries(
      entries,
      modelCostMap,
    );

    const staleBillingCache =
      Boolean(sessionState?.usage) &&
      sessionState?.usage?.billingVersion !== USAGE_BILLING_CACHE_VERSION;
    const pricingRefreshCache =
      sessionState?.usage &&
      shouldRecomputeUsageCache(sessionState.usage, pricingFingerprint);
    const forceRescan =
      forceRescanSessions.has(sessionID) ||
      sessionState?.dirty === true ||
      staleBillingCache ||
      Boolean(pricingRefreshCache);
    if (forceRescan) forceRescanSessions.delete(sessionID);

    if (staleBillingCache) {
      debug(`usage cache billing refresh for session ${sessionID}`);
    }
    if (pricingRefreshCache && !staleBillingCache) {
      debug(`usage cache pricing refresh for session ${sessionID}`);
    }

    const { usage, cursor } = summarizeMessagesIncremental(
      entries,
      sessionState?.usage,
      sessionState?.cursor,
      forceRescan,
      {
        calcApiCost: (message) => calcEquivalentApiCost(message, modelCostMap),
        classifyCacheMode: (message) =>
          classifyCacheMode(message, modelCostMap),
      },
    );
    usage.sessionCount = 1;

    // Update cursor in state
    if (sessionState) {
      sessionState.cursor = cursor;
      sessionState.dirty = false;
    }

    if ((dirtyGeneration.get(sessionID) || 0) === generationAtStart) {
      cleanGeneration.set(sessionID, generationAtStart);
    }

    return {
      usage,
      persist: true,
      pricingFingerprint,
      pricingKeys,
    };
  };

  const summarizeSessionUsageLocked = async (
    sessionID: string,
    options?: { requireEntries?: boolean },
  ) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generationAtStart = dirtyGeneration.get(sessionID) || 0;

      const existing = usageInFlight.get(sessionID);
      if (existing && existing.generation === generationAtStart) {
        const result = await existing.promise;
        if ((dirtyGeneration.get(sessionID) || 0) !== generationAtStart)
          continue;
        return result;
      }

      const promise = summarizeSessionUsage(
        sessionID,
        generationAtStart,
        options,
      );
      const entry = { generation: generationAtStart, promise };
      void promise
        .finally(() => {
          const current = usageInFlight.get(sessionID);
          if (current?.promise === promise) usageInFlight.delete(sessionID);
        })
        .catch(() => undefined);
      usageInFlight.set(sessionID, entry);

      const result = await promise;
      if ((dirtyGeneration.get(sessionID) || 0) !== generationAtStart) continue;
      return result;
    }

    const generationAtStart = dirtyGeneration.get(sessionID) || 0;
    return summarizeSessionUsage(sessionID, generationAtStart);
  };

  const summarizeSessionUsageForDisplay = async (
    sessionID: string,
    includeChildren: boolean,
  ): Promise<UsageSummary> => {
    const modelCostMap = await getModelCostMap();
    const root = await summarizeSessionUsageLocked(sessionID);
    const usage = root.usage;
    let dirty = false;
    if (root.persist) {
      persistSessionUsage(
        sessionID,
        toCachedSessionUsage(usage, {
          pricingFingerprint: root.pricingFingerprint,
          pricingKeys: root.pricingKeys,
        }),
      );
      dirty = true;
    }
    if (!includeChildren) {
      if (dirty) deps.persistence.scheduleSave();
      return usage;
    }

    const descendantIDs =
      await deps.descendantsResolver.listDescendantSessionIDs(sessionID, {
        maxDepth: deps.config.sidebar.childrenMaxDepth,
        maxSessions: deps.config.sidebar.childrenMaxSessions,
        concurrency: deps.config.sidebar.childrenConcurrency,
      });
    if (descendantIDs.length === 0) {
      if (dirty) deps.persistence.scheduleSave();
      return usage;
    }

    const merged = emptyUsageSummary();
    mergeUsage(merged, usage);

    const needsFetch: string[] = [];
    for (const childID of descendantIDs) {
      const cached = deps.state.sessions[childID]?.usage;
      if (
        cached &&
        !isDirty(childID) &&
        isUsageBillingCurrent(
          cached,
          expectedPricingFingerprintForCached(cached, modelCostMap),
        )
      ) {
        // Keep measured cost aligned with OpenCode session semantics by only
        // using child sessions for token/API-cost aggregation.
        mergeUsage(merged, fromCachedSessionUsage(cached, 1), {
          includeCost: false,
        });
      } else {
        needsFetch.push(childID);
      }
    }

    if (needsFetch.length > 0) {
      const fetched = await mapConcurrent(
        needsFetch,
        deps.config.sidebar.childrenConcurrency,
        async (childID) => {
          const child = await summarizeSessionUsageLocked(childID);
          if (child.persist) {
            persistSessionUsage(
              childID,
              toCachedSessionUsage(child.usage, {
                pricingFingerprint: child.pricingFingerprint,
                pricingKeys: child.pricingKeys,
              }),
            );
            dirty = true;
          }
          return child.usage;
        },
      );

      for (const childUsage of fetched) {
        mergeUsage(merged, childUsage, { includeCost: false });
      }
    }

    if (dirty) deps.persistence.scheduleSave();
    return merged;
  };

  const RANGE_USAGE_CONCURRENCY = 5;

  const filterRangeSessions = <
    T extends {
      state: { createdAt: number; cursor?: IncrementalCursor; dirty?: boolean };
    },
  >(
    sessions: T[],
    startAt: number,
    endAt: number,
  ) => {
    return sessions.filter((session) => {
      if (session.state.createdAt > endAt) return false;
      if (session.state.dirty === true) return true;
      const lastMessageTime = session.state.cursor?.lastMessageTime;
      if (
        typeof lastMessageTime === "number" &&
        Number.isFinite(lastMessageTime) &&
        lastMessageTime < startAt
      ) {
        return false;
      }
      return true;
    });
  };

  const summarizeRangeUsage = async (period: "day" | "week" | "month") => {
    const now = Date.now();
    const startAt = periodStart(period, now);
    const endAt = now;
    await deps.persistence.flushSave();
    const sessions = filterRangeSessions(
      await scanAllSessions(deps.statePath, deps.state),
      startAt,
      endAt,
    );
    const usage = emptyUsageSummary();
    const modelCostMap = await getModelCostMap();

    if (sessions.length > 0) {
      const fetched = await mapConcurrent(
        sessions,
        RANGE_USAGE_CONCURRENCY,
        async (session) => {
          const usageOptions = {
            calcApiCost: (message: AssistantMessage) =>
              calcEquivalentApiCost(message, modelCostMap),
            classifyCacheMode: (message: AssistantMessage) =>
              classifyCacheMode(message, modelCostMap),
          };
          const computed = emptyUsageSummary();
          const trackFullUsage = shouldTrackFullUsageForRange(
            session.state.usage,
            modelCostMap,
          );
          const fullUsage = trackFullUsage ? emptyUsageSummary() : undefined;
          let cursor: IncrementalCursor | undefined;
          const pricingKeys = new Set<string>();
          let before: string | undefined;

          while (true) {
            const load = await loadSessionEntriesPage(
              session.sessionID,
              before,
            );
            if (load.status !== "ok") {
              return {
                sessionID: session.sessionID,
                dateKey: session.dateKey,
                createdAt: session.state.createdAt,
                lastMessageTime: session.state.cursor?.lastMessageTime,
                dirty: session.state.dirty === true,
                computed: emptyUsageSummary(),
                fullUsage: undefined,
                loadFailed: load.status === "error",
                missing: load.status === "missing",
                persist: false,
                cursor: undefined,
              };
            }

            const entries = load.entries;
            if (entries.length === 0) break;

            accumulateMessagesInCompletedRange(
              computed,
              entries,
              startAt,
              endAt,
              usageOptions,
            );

            if (fullUsage) {
              accumulateMessagesInCompletedRange(
                fullUsage,
                entries,
                0,
                Number.POSITIVE_INFINITY,
                usageOptions,
              );
              cursor = mergeCursorFromEntries(cursor, entries);
              collectPricingKeys(entries, pricingKeys);
            }

            if (!load.nextBefore) break;
            before = load.nextBefore;
          }

          const shouldPersistFullUsage =
            !!fullUsage &&
            (!session.state.usage ||
              shouldRecomputeUsageCache(
                session.state.usage,
                pricingFingerprintForKeys([...pricingKeys], modelCostMap),
              ));

          return {
            sessionID: session.sessionID,
            dateKey: session.dateKey,
            createdAt: session.state.createdAt,
            lastMessageTime: cursor?.lastMessageTime,
            dirty: session.state.dirty === true,
            computed,
            fullUsage: shouldPersistFullUsage ? fullUsage : undefined,
            pricingFingerprint: fullUsage
              ? pricingFingerprintForKeys([...pricingKeys], modelCostMap)
              : undefined,
            pricingKeys: fullUsage ? [...pricingKeys].sort() : undefined,
            loadFailed: false,
            missing: false,
            persist: shouldPersistFullUsage,
            cursor,
          };
        },
      );

      const missingSessions = fetched.filter((item) => item.missing);
      if (missingSessions.length > 0) {
        let stateChanged = false;

        for (const missing of missingSessions) {
          deps.state.deletedSessionDateMap[missing.sessionID] = missing.dateKey;
          delete deps.state.sessions[missing.sessionID];
          delete deps.state.sessionDateMap[missing.sessionID];
          deps.persistence.markDirty(missing.dateKey);
          forgetSession(missing.sessionID);
          stateChanged = true;
        }

        await Promise.all(
          missingSessions.map(async (missing) => {
            const deletedFromChunk = await deleteSessionFromDayChunk(
              deps.statePath,
              missing.sessionID,
              missing.dateKey,
            ).catch((error) => {
              swallow("deleteSessionFromDayChunk")(error);
              return false;
            });
            if (!deletedFromChunk) return;
            delete deps.state.deletedSessionDateMap[missing.sessionID];
            stateChanged = true;
          }),
        );

        if (stateChanged) deps.persistence.scheduleSave();
      }

      const failedLoads = fetched.filter((item) => {
        if (!item.loadFailed) return false;
        if (item.dirty) return true;
        const lastMessageTime = item.lastMessageTime;
        if (typeof lastMessageTime === "number" && lastMessageTime < startAt) {
          return false;
        }
        return true;
      });
      if (failedLoads.length > 0) {
        throw new Error(
          `range usage unavailable: failed to load ${failedLoads.length} session(s)`,
        );
      }

      let dirty = false;
      const diskOnlyUpdates: Array<{
        sessionID: string;
        dateKey: string;
        usage: CachedSessionUsage;
        cursor: IncrementalCursor | undefined;
      }> = [];

      for (const {
        sessionID,
        dateKey,
        computed,
        fullUsage,
        pricingFingerprint,
        pricingKeys,
        persist,
        cursor,
      } of fetched) {
        if (computed.assistantMessages > 0) {
          computed.sessionCount = 1;
          mergeUsage(usage, computed);
        }
        const memoryState = deps.state.sessions[sessionID];
        if (persist && fullUsage && memoryState) {
          memoryState.usage = toCachedSessionUsage(fullUsage, {
            pricingFingerprint,
            pricingKeys,
          });
          memoryState.cursor = cursor;
          const resolvedDateKey =
            deps.state.sessionDateMap[sessionID] ||
            dateKeyFromTimestamp(memoryState.createdAt);
          deps.state.sessionDateMap[sessionID] = resolvedDateKey;
          deps.persistence.markDirty(resolvedDateKey);
          memoryState.dirty = false;
          dirty = true;
        } else if (persist && fullUsage) {
          diskOnlyUpdates.push({
            sessionID,
            dateKey,
            usage: toCachedSessionUsage(fullUsage, {
              pricingFingerprint,
              pricingKeys,
            }),
            cursor,
          });
        }
      }

      if (diskOnlyUpdates.length > 0) {
        const persisted = await updateSessionsInDayChunks(
          deps.statePath,
          diskOnlyUpdates,
        ).catch((error) => {
          swallow("updateSessionsInDayChunks")(error);
          return false;
        });
        if (!persisted) {
          throw new Error(
            `range usage unavailable: failed to persist ${diskOnlyUpdates.length} disk-only session(s)`,
          );
        }
      }

      if (dirty) deps.persistence.scheduleSave();
    }

    return usage;
  };

  const summarizeHistoryUsage = async (
    period: HistoryPeriod,
    rawSince: string,
  ): Promise<HistoryUsageResult> => {
    await deps.persistence.flushSave();
    const sessions = await scanAllSessions(deps.statePath, deps.state);

    const result = await computeHistoryUsage(
      {
        sessions,
        loadMessagesPage: loadSessionEntriesPage,
        getModelCostMap: getModelCostMap as () => Promise<
          Record<string, unknown>
        >,
        calcApiCost: (message, costMap) =>
          calcEquivalentApiCost(
            message,
            costMap as Record<string, ModelCostRates>,
          ),
        classifyCacheMode: (message, costMap) =>
          classifyCacheMode(message, costMap as Record<string, ModelCostRates>),
        hasResolvableApiCostMessages: (entries, costMap) =>
          hasResolvableApiCostMessages(
            entries,
            costMap as Record<string, ModelCostRates>,
          ),
        pricingFingerprintForKeys: (
          pricingKeys: string[],
          costMap: Record<string, unknown>,
        ) =>
          pricingFingerprintForKeys(
            pricingKeys,
            costMap as Record<string, ModelCostRates>,
          ),
        isUsageBillingCurrent: (
          cached: CachedSessionUsage | undefined,
          costMap: Record<string, unknown>,
        ) =>
          isUsageBillingCurrent(
            cached,
            expectedPricingFingerprintForCached(
              cached,
              costMap as Record<string, ModelCostRates>,
            ),
          ),
        shouldTrackFullUsage: shouldTrackFullUsageForRange,
        shouldRecomputeUsageCache,
        throwOnLoadFailure: true,
      },
      period,
      rawSince,
    );

    // Server-side persistence: persist recomputed full-session usage back to
    // memory state and day chunks so future queries are faster.
    const hints = result.persistenceHints;
    if (hints && hints.length > 0) {
      const missingSessions = hints.filter((item) => item.missing);
      if (missingSessions.length > 0) {
        let stateChanged = false;
        for (const missing of missingSessions) {
          deps.state.deletedSessionDateMap[missing.sessionID] = missing.dateKey;
          delete deps.state.sessions[missing.sessionID];
          delete deps.state.sessionDateMap[missing.sessionID];
          deps.persistence.markDirty(missing.dateKey);
          forgetSession(missing.sessionID);
          stateChanged = true;
        }
        await Promise.all(
          missingSessions.map(async (missing) => {
            const deletedFromChunk = await deleteSessionFromDayChunk(
              deps.statePath,
              missing.sessionID,
              missing.dateKey,
            ).catch((error) => {
              swallow("deleteSessionFromDayChunk")(error);
              return false;
            });
            if (!deletedFromChunk) return;
            delete deps.state.deletedSessionDateMap[missing.sessionID];
            stateChanged = true;
          }),
        );
        if (stateChanged) deps.persistence.scheduleSave();
      }

      let dirty = false;
      const diskOnlyUpdates: Array<{
        sessionID: string;
        dateKey: string;
        usage: CachedSessionUsage;
        cursor: IncrementalCursor | undefined;
      }> = [];

      for (const item of hints) {
        if (!item.persist || !item.fullUsage) continue;
        const memoryState = deps.state.sessions[item.sessionID];
        if (memoryState) {
          memoryState.usage = toCachedSessionUsage(item.fullUsage, {
            pricingFingerprint: item.pricingFingerprint,
            pricingKeys: item.pricingKeys,
          });
          memoryState.cursor = item.cursor;
          const resolvedDateKey =
            deps.state.sessionDateMap[item.sessionID] ||
            dateKeyFromTimestamp(memoryState.createdAt);
          deps.state.sessionDateMap[item.sessionID] = resolvedDateKey;
          deps.persistence.markDirty(resolvedDateKey);
          memoryState.dirty = false;
          dirty = true;
        } else {
          diskOnlyUpdates.push({
            sessionID: item.sessionID,
            dateKey: item.dateKey,
            usage: toCachedSessionUsage(item.fullUsage, {
              pricingFingerprint: item.pricingFingerprint,
              pricingKeys: item.pricingKeys,
            }),
            cursor: item.cursor,
          });
        }
      }

      if (diskOnlyUpdates.length > 0) {
        const persisted = await updateSessionsInDayChunks(
          deps.statePath,
          diskOnlyUpdates,
        ).catch((error) => {
          swallow("updateSessionsInDayChunks")(error);
          return false;
        });
        if (!persisted) {
          throw new Error(
            `history usage unavailable: failed to persist ${diskOnlyUpdates.length} disk-only session(s)`,
          );
        }
      }

      if (dirty) deps.persistence.scheduleSave();
    }

    return result;
  };

  const summarizeForTool = async (
    period: "session" | "day" | "week" | "month",
    sessionID: string,
    includeChildren: boolean,
  ) => {
    if (period === "session") {
      if (!includeChildren) {
        const session = await summarizeSessionUsageLocked(sessionID, {
          requireEntries: true,
        });
        if (session.persist) {
          persistSessionUsage(
            sessionID,
            toCachedSessionUsage(session.usage, {
              pricingFingerprint: session.pricingFingerprint,
              pricingKeys: session.pricingKeys,
            }),
          );
          deps.persistence.scheduleSave();
        }
        return session.usage;
      }
      return summarizeSessionUsageForDisplay(sessionID, includeChildren);
    }
    return summarizeRangeUsage(period);
  };

  const markSessionDirty = (sessionID: string) => {
    bumpDirty(sessionID);
    const sessionState = deps.state.sessions[sessionID];
    if (sessionState && !sessionState.dirty) {
      sessionState.dirty = true;
      const dateKey =
        deps.state.sessionDateMap[sessionID] ||
        dateKeyFromTimestamp(sessionState.createdAt);
      deps.state.sessionDateMap[sessionID] = dateKey;
      deps.persistence.markDirty(dateKey);
      deps.persistence.scheduleSave();
    }
  };

  const markForceRescan = (sessionID: string) => {
    forceRescanSessions.add(sessionID);
    bumpDirty(sessionID);
    const sessionState = deps.state.sessions[sessionID];
    if (sessionState) {
      sessionState.usage = undefined;
      sessionState.cursor = undefined;
      const dateKey =
        deps.state.sessionDateMap[sessionID] ||
        dateKeyFromTimestamp(sessionState.createdAt);
      deps.state.sessionDateMap[sessionID] = dateKey;
      deps.persistence.markDirty(dateKey);
      deps.persistence.scheduleSave();
    }
  };

  const forgetSession = (sessionID: string) => {
    forceRescanSessions.delete(sessionID);
    dirtyGeneration.delete(sessionID);
    cleanGeneration.delete(sessionID);
    usageInFlight.delete(sessionID);
  };

  return {
    summarizeSessionUsageForDisplay,
    summarizeForTool,
    summarizeHistoryUsage,
    markSessionDirty,
    markForceRescan,
    forgetSession,
  };
}
