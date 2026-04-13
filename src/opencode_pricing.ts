import fs from "node:fs/promises";
import path from "node:path";

import { debug, isRecord } from "./helpers.js";

export type OpenCodePricingModel = {
  providerKey?: string;
  providerID: string;
  modelID: string;
  modelKey?: string;
  cost?: unknown;
  options?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  api?: Record<string, unknown>;
  limit?: Record<string, unknown>;
};

function stripJsonComments(input: string) {
  let output = "";
  let inString = false;
  let escaping = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input: string) {
  let output = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char !== ",") {
      output += char;
      continue;
    }

    let lookahead = index + 1;
    while (lookahead < input.length && /\s/.test(input[lookahead])) {
      lookahead += 1;
    }
    if (input[lookahead] === "}" || input[lookahead] === "]") continue;
    output += char;
  }

  return output;
}

export function parseJsonc(text: string) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
}

type ProviderEntry = {
  providerKey?: string;
  providerID: string;
  value: Record<string, unknown>;
};

function providerEntriesFromCollection(value: unknown) {
  const providers: ProviderEntry[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const providerID = typeof item.id === "string" ? item.id : undefined;
      if (!providerID) continue;
      providers.push({ providerKey: providerID, providerID, value: item });
    }
    return providers;
  }

  if (!isRecord(value)) return providers;

  for (const [providerKey, providerValue] of Object.entries(value)) {
    if (!isRecord(providerValue)) continue;
    const providerID =
      typeof providerValue.id === "string" ? providerValue.id : providerKey;
    providers.push({ providerKey, providerID, value: providerValue });
  }

  return providers;
}

function mergeRecord(
  base: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  if (!base) return next;
  if (!next) return base;
  return {
    ...base,
    ...next,
  };
}

function mergeDeepRecord(
  base: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base) return next;
  if (!next) return base;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value)
        ? mergeDeepRecord(existing, value)
        : value;
  }
  return merged;
}

function mergeCost(
  base: OpenCodePricingModel["cost"],
  next: OpenCodePricingModel["cost"],
) {
  if (isRecord(base) && isRecord(next)) {
    return mergeDeepRecord(base, next);
  }
  return next ?? base;
}

function extractModelsFromProvider(provider: ProviderEntry) {
  const models = provider.value.models;
  const entries: OpenCodePricingModel[] = [];

  const pushModel = (
    modelKey: string | undefined,
    value: Record<string, unknown>,
  ) => {
    const modelID = typeof value.id === "string" ? value.id : modelKey;
    if (!modelID) return;
    entries.push({
      providerKey: provider.providerKey,
      providerID: provider.providerID,
      modelID,
      modelKey,
      cost: value.cost,
      options: isRecord(value.options) ? value.options : undefined,
      headers: isRecord(value.headers) ? value.headers : undefined,
      api: isRecord(value.api) ? value.api : undefined,
      limit: isRecord(value.limit) ? value.limit : undefined,
    });
  };

  if (Array.isArray(models)) {
    for (const item of models) {
      if (!isRecord(item)) continue;
      pushModel(typeof item.id === "string" ? item.id : undefined, item);
    }
    return entries;
  }

  if (!isRecord(models)) return entries;

  for (const [modelKey, modelValue] of Object.entries(models)) {
    if (!isRecord(modelValue)) continue;
    pushModel(modelKey, modelValue);
  }

  return entries;
}

function mergedModelMapKey(model: OpenCodePricingModel) {
  return `${model.providerKey || model.providerID}:${model.modelKey || model.modelID}`;
}

function mergedProviderID(
  existing: OpenCodePricingModel | undefined,
  next: OpenCodePricingModel,
) {
  if (
    next.providerKey &&
    next.providerID === next.providerKey &&
    existing?.providerID
  ) {
    return existing.providerID;
  }
  return (
    next.providerID || existing?.providerID || next.providerKey || "unknown"
  );
}

function mergedModelID(
  existing: OpenCodePricingModel | undefined,
  next: OpenCodePricingModel,
) {
  if (next.modelKey && next.modelID === next.modelKey && existing?.modelID) {
    return existing.modelID;
  }
  return next.modelID || existing?.modelID || next.modelKey || "unknown";
}

export function extractOpenCodePricingModels(config: unknown) {
  if (!isRecord(config)) return [] as OpenCodePricingModel[];

  const providers = [
    ...providerEntriesFromCollection(config.provider),
    ...providerEntriesFromCollection(config.providers),
  ];

  const merged = new Map<string, OpenCodePricingModel>();
  for (const provider of providers) {
    for (const model of extractModelsFromProvider(provider)) {
      const key = mergedModelMapKey(model);
      const existing = merged.get(key);
      merged.set(key, {
        providerKey: model.providerKey ?? existing?.providerKey,
        providerID: mergedProviderID(existing, model),
        modelID: mergedModelID(existing, model),
        modelKey: model.modelKey ?? existing?.modelKey,
        cost: mergeCost(existing?.cost, model.cost),
        options: mergeRecord(existing?.options, model.options),
        headers: mergeRecord(existing?.headers, model.headers),
        api: mergeRecord(existing?.api, model.api),
        limit: mergeRecord(existing?.limit, model.limit),
      });
    }
  }

  return [...merged.values()];
}

export async function loadOpenCodePricingModels(paths: string[]) {
  const seen = new Set<string>();
  const merged = new Map<string, OpenCodePricingModel>();

  for (const originalPath of paths) {
    const filePath = path.resolve(originalPath);
    const key =
      process.platform === "win32" ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) continue;
    seen.add(key);

    const stat = await fs.stat(filePath).catch(() => undefined);
    if (!stat?.isFile()) continue;

    const parsed = await fs
      .readFile(filePath, "utf8")
      .then((text: string) => parseJsonc(text))
      .catch((error: unknown) => {
        debug(
          `loadOpenCodePricingModels skipped ${filePath}: ${String(error)}`,
        );
        return undefined;
      });

    for (const model of extractOpenCodePricingModels(parsed)) {
      const mergedKey = mergedModelMapKey(model);
      const existing = merged.get(mergedKey);
      merged.set(mergedKey, {
        providerKey: model.providerKey ?? existing?.providerKey,
        providerID: mergedProviderID(existing, model),
        modelID: mergedModelID(existing, model),
        modelKey: model.modelKey ?? existing?.modelKey,
        cost: mergeCost(existing?.cost, model.cost),
        options: mergeRecord(existing?.options, model.options),
        headers: mergeRecord(existing?.headers, model.headers),
        api: mergeRecord(existing?.api, model.api),
        limit: mergeRecord(existing?.limit, model.limit),
      });
    }
  }

  return [...merged.values()];
}
