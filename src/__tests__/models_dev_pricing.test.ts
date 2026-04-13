import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  clearModelsDevPricingCache,
  loadModelsDevPricingModels,
  modelsDevHasProvider,
} from "../models_dev_pricing.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  clearModelsDevPricingCache();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
});

describe("models.dev pricing supplement", () => {
  it("recognizes supported provider families", () => {
    assert.equal(modelsDevHasProvider("openai"), true);
    assert.equal(modelsDevHasProvider("anthropic"), true);
    assert.equal(modelsDevHasProvider("kimi-for-coding"), true);
    assert.equal(modelsDevHasProvider("zhipuai-coding-plan"), true);
    assert.equal(modelsDevHasProvider("minimax-cn-coding-plan"), true);
    assert.equal(modelsDevHasProvider("perplexity"), false);
  });

  it("loads prices from models.dev raw TOML for exact model matches", async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input: string | URL | Request,
    ) => {
      const url = String(input);
      assert.match(url, /providers\/openai\/models\/gpt-5\.4\.toml$/);
      return new Response(
        `name = "GPT-5.4"

[cost]
input = 2.50
output = 15.00
cache_read = 0.25

[cost.context_over_200k]
input = 5.00
output = 22.50
cache_read = 0.50
`,
        { status: 200 },
      );
    };

    const models = await loadModelsDevPricingModels([
      {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    ]);

    assert.deepEqual(models, [
      {
        providerID: "openai",
        modelID: "gpt-5.4",
        modelKey: undefined,
        providerKey: undefined,
        options: undefined,
        headers: undefined,
        api: undefined,
        limit: undefined,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          cache_write: 0,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
            cache_write: 0,
          },
        },
      },
    ]);
  });

  it("resolves provider aliases and model aliases when looking up models.dev files", async () => {
    const requested: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input: string | URL | Request,
    ) => {
      const url = String(input);
      requested.push(url);

      if (/providers\/moonshotai\/models\/k2p5\.toml$/.test(url)) {
        return new Response("", { status: 404 });
      }
      if (/providers\/moonshotai\/models\/kimi-k2\.5\.toml$/.test(url)) {
        return new Response(
          `[cost]
input = 0.6
output = 3
cache_read = 0.1
`,
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    const models = await loadModelsDevPricingModels([
      {
        providerID: "kimi-for-coding",
        modelID: "k2p5",
      },
    ]);

    assert.equal(models.length, 1);
    assert.equal(models[0]?.providerID, "kimi-for-coding");
    assert.deepEqual(models[0]?.cost, {
      input: 0.6,
      output: 3,
      cache_read: 0.1,
      cache_write: 0,
    });
    assert.equal(
      requested.some((url) => /kimi-k2\.5\.toml$/.test(url)),
      true,
    );
  });

  it("resolves multiple missing models concurrently", async () => {
    const started: string[] = [];
    let releaseFetches: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input: string | URL | Request,
    ) => {
      const url = String(input);
      started.push(url);
      await gate;

      if (/gpt-5\.1\.toml$/.test(url)) {
        return new Response(`[cost]\ninput = 1\noutput = 2\n`, {
          status: 200,
        });
      }
      if (/gpt-5\.2\.toml$/.test(url)) {
        return new Response(`[cost]\ninput = 3\noutput = 4\n`, {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    };

    const pending = loadModelsDevPricingModels([
      { providerID: "openai", modelID: "gpt-5.1" },
      { providerID: "openai", modelID: "gpt-5.2" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(started.length, 2);

    releaseFetches?.();
    const models = await pending;
    assert.deepEqual(models.map((model) => model.modelID).sort(), [
      "gpt-5.1",
      "gpt-5.2",
    ]);
  });
});
