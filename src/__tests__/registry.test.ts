import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultProviderRegistry } from "../providers/index.js";

describe("provider registry", () => {
  it("prefers RightCode adapter over provider ID when baseURL matches", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://www.right.codes/codex/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "rightcode");
  });

  it("prefers Buzz adapter over provider ID when baseURL matches", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://buzzai.cc/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "buzz");
  });

  it("matches canonical xyai provider", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "xyai",
      providerOptions: {},
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "xyai");
  });

  it("prefers xyai adapter when baseURL matches site endpoint", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://new.xychatai.com/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "xyai");
  });

  it("matches built-in kimi-for-coding provider", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "kimi-for-coding",
      providerOptions: {},
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "kimi-for-coding");
  });

  it("prefers kimi-for-coding adapter when baseURL matches coding endpoint", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://api.kimi.com/coding/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "kimi-for-coding");
  });

  it("matches zhipu coding plan by provider id", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "zhipuai-coding-plan",
      providerOptions: {},
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "zhipuai-coding-plan");
  });

  it("matches minimax coding plan by provider id", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "minimax-cn-coding-plan",
      providerOptions: {},
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "minimax-cn-coding-plan");
  });

  it("prefers minimax coding plan adapter when baseURL matches coding endpoint", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://api.minimaxi.com/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "minimax-cn-coding-plan");
  });

  it("prefers zhipu coding plan adapter when baseURL matches coding endpoint", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://open.bigmodel.cn/api/anthropic" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "zhipuai-coding-plan");
  });

  it("normalizes known provider variants", () => {
    const registry = createDefaultProviderRegistry();
    assert.equal(
      registry.normalizeProviderID("github-copilot-enterprise"),
      "github-copilot",
    );
    assert.equal(
      registry.normalizeProviderID("kimi-for-coding"),
      "kimi-for-coding",
    );
    assert.equal(
      registry.normalizeProviderID("zhipuai-coding-plan"),
      "zhipuai-coding-plan",
    );
    assert.equal(
      registry.normalizeProviderID("minimax-cn-coding-plan"),
      "minimax-cn-coding-plan",
    );
    assert.equal(registry.normalizeProviderID("xyai-vibe"), "xyai");
    assert.equal(registry.normalizeProviderID("openai"), "openai");
  });

  it("does not match RightCode adapter for non-right baseURL", () => {
    const registry = createDefaultProviderRegistry();
    const adapter = registry.resolve({
      providerID: "openai",
      providerOptions: { baseURL: "https://api.openai.com/v1" },
    });
    assert.ok(adapter);
    assert.equal(adapter!.id, "openai");
  });
});
