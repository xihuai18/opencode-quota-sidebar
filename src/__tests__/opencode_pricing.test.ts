import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  extractOpenCodePricingModels,
  loadOpenCodePricingModels,
  parseJsonc,
} from "../opencode_pricing.js";

const tmpDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "opencode-pricing-test-"),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0, tmpDirs.length)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("opencode pricing config", () => {
  it("parses JSONC with comments and trailing commas", () => {
    const parsed = parseJsonc(`{
      // comment
      "provider": {
        "openai": {
          "models": {
            "gpt-5": {
              "id": "gpt-5",
              "cost": { "input": 2.5, "output": 15, },
            },
          },
        },
      },
    }`) as Record<string, unknown>;

    assert.equal(typeof parsed.provider, "object");
  });

  it("extracts provider model pricing metadata from opencode config shapes", () => {
    const models = extractOpenCodePricingModels({
      provider: {
        openai: {
          models: {
            "gpt-5-fast": {
              id: "gpt-5-fast",
              cost: { input: 5, output: 30 },
              options: { serviceTier: "priority" },
              api: { id: "gpt-5" },
            },
          },
        },
      },
      providers: [
        {
          id: "anthropic",
          models: [
            {
              id: "claude-sonnet-4-5-fast",
              options: { speed: "fast" },
              headers: { "anthropic-beta": "fast-mode-2026-01-01" },
              api: { id: "claude-sonnet-4-5" },
            },
          ],
        },
      ],
    });

    assert.deepEqual(
      models.map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        serviceTier: model.options?.serviceTier,
        speed: model.options?.speed,
        apiID: model.api?.id,
      })),
      [
        {
          providerID: "openai",
          modelID: "gpt-5-fast",
          serviceTier: "priority",
          speed: undefined,
          apiID: "gpt-5",
        },
        {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5-fast",
          serviceTier: undefined,
          speed: "fast",
          apiID: "claude-sonnet-4-5",
        },
      ],
    );
  });

  it("merges later opencode config layers without discarding earlier metadata", async () => {
    const dir = await makeTempDir();
    const basePath = path.join(dir, "opencode.jsonc");
    const overridePath = path.join(dir, ".opencode.jsonc");

    await fs.writeFile(
      basePath,
      `{
        "provider": {
          "openai": {
            "models": {
                "gpt-5": {
                  "id": "gpt-5",
                  "cost": {
                    "input": 2.5,
                    "output": 15,
                    "cache_read": 0.25,
                    "context_over_200k": {
                      "input": 5,
                      "output": 22.5,
                      "cache_read": 0.5
                    }
                  },
                  "api": { "id": "gpt-5-base" }
                }
              }
          }
        }
      }`,
    );
    await fs.writeFile(
      overridePath,
      `{
        "provider": {
          "openai": {
            "models": {
              "gpt-5": {
                "cost": { "input": 3, "output": 18 },
                "options": { "serviceTier": "priority" }
              }
            }
          }
        }
      }`,
    );

    const models = await loadOpenCodePricingModels([basePath, overridePath]);
    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
      providerKey: "openai",
      providerID: "openai",
      modelID: "gpt-5",
      modelKey: "gpt-5",
      cost: {
        input: 3,
        output: 18,
        cache_read: 0.25,
        context_over_200k: {
          input: 5,
          output: 22.5,
          cache_read: 0.5,
        },
      },
      options: { serviceTier: "priority" },
      headers: undefined,
      api: { id: "gpt-5-base" },
      limit: undefined,
    });
  });

  it("keeps earlier id when a later keyed override omits id", async () => {
    const dir = await makeTempDir();
    const basePath = path.join(dir, "opencode.jsonc");
    const overridePath = path.join(dir, ".opencode.jsonc");

    await fs.writeFile(
      basePath,
      `{
        "provider": {
          "openai": {
            "models": {
              "flagship": {
                "id": "gpt-5",
                "cost": { "input": 2.5, "output": 15 }
              }
            }
          }
        }
      }`,
    );
    await fs.writeFile(
      overridePath,
      `{
        "provider": {
          "openai": {
            "models": {
              "flagship": {
                "cost": { "input": 3, "output": 18 }
              }
            }
          }
        }
      }`,
    );

    const models = await loadOpenCodePricingModels([basePath, overridePath]);
    assert.equal(models.length, 1);
    assert.equal(models[0]?.modelID, "gpt-5");
    assert.deepEqual(models[0]?.cost, { input: 3, output: 18 });
  });

  it("keeps earlier provider id when a later keyed provider override omits id", async () => {
    const dir = await makeTempDir();
    const basePath = path.join(dir, "opencode.jsonc");
    const overridePath = path.join(dir, ".opencode.jsonc");

    await fs.writeFile(
      basePath,
      `{
        "provider": {
          "oai-prod": {
            "id": "openai",
            "models": {
              "gpt-5": {
                "id": "gpt-5",
                "cost": { "input": 2.5, "output": 15 }
              }
            }
          }
        }
      }`,
    );
    await fs.writeFile(
      overridePath,
      `{
        "provider": {
          "oai-prod": {
            "models": {
              "gpt-5": {
                "cost": { "input": 3, "output": 18 }
              }
            }
          }
        }
      }`,
    );

    const models = await loadOpenCodePricingModels([basePath, overridePath]);
    assert.equal(models.length, 1);
    assert.equal(models[0]?.providerKey, "oai-prod");
    assert.equal(models[0]?.providerID, "openai");
    assert.equal(models[0]?.modelID, "gpt-5");
    assert.deepEqual(models[0]?.cost, { input: 3, output: 18 });
  });
});
