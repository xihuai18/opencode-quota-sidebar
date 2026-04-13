import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createUsageService } from "../usage_service.js";
import {
  USAGE_BILLING_CACHE_VERSION,
  getCacheCoverageMetrics,
} from "../usage.js";
import type { QuotaSidebarConfig, QuotaSidebarState } from "../types.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeConfig(): QuotaSidebarConfig {
  return {
    sidebar: {
      enabled: true,
      width: 36,
      showCost: true,
      showQuota: true,
      wrapQuotaLines: true,
      includeChildren: false,
      childrenMaxDepth: 6,
      childrenMaxSessions: 128,
      childrenConcurrency: 5,
    },
    quota: {
      refreshMs: 300_000,
      includeOpenAI: true,
      includeCopilot: true,
      includeAnthropic: true,
      providers: {},
      refreshAccessToken: false,
      requestTimeoutMs: 8_000,
    },
    toast: { durationMs: 12_000 },
    retentionDays: 730,
  };
}

function makeState(): QuotaSidebarState {
  return {
    version: 2,
    titleEnabled: true,
    sessionDateMap: {},
    sessions: {},
    deletedSessionDateMap: {},
    quotaCache: {},
  };
}

function entry(sessionID: string, messageID: string, input: number) {
  const now = Date.now();
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5",
      time: { created: now - 10, completed: now },
      tokens: {
        input,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    },
  };
}

describe("usage service", () => {
  it("summarizes history across multiple day rows", async () => {
    const state = makeState();
    const config = makeConfig();
    const dayOne = new Date(2026, 3, 10, 12).getTime();
    const dayTwo = new Date(2026, 3, 11, 12).getTime();

    state.sessions.s1 = {
      createdAt: dayOne,
      baseTitle: "S1",
      lastAppliedTitle: undefined,
      cursor: { lastMessageTime: dayTwo },
    };
    state.sessionDateMap.s1 = "2026-04-10";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m1",
                  sessionID: "s1",
                  role: "assistant",
                  providerID: "openai",
                  modelID: "gpt-5",
                  time: { created: dayOne, completed: dayOne },
                  tokens: {
                    input: 100,
                    output: 20,
                    reasoning: 0,
                    cache: { read: 10, write: 0 },
                  },
                  cost: 1,
                },
              },
              {
                info: {
                  id: "m2",
                  sessionID: "s1",
                  role: "assistant",
                  providerID: "openai",
                  modelID: "gpt-5",
                  time: { created: dayTwo, completed: dayTwo },
                  tokens: {
                    input: 200,
                    output: 40,
                    reasoning: 0,
                    cache: { read: 20, write: 0 },
                  },
                  cost: 2,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({ data: { all: [], default: {}, connected: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const realNow = Date.now;
    Date.now = () => new Date(2026, 3, 11, 23, 59, 59).getTime();
    let result;
    try {
      result = await service.summarizeHistoryUsage("day", "2026-04-10");
    } finally {
      Date.now = realNow;
    }

    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].range.label, "2026-04-10");
    assert.equal(result.rows[0].usage.input, 100);
    assert.equal(result.rows[1].range.label, "2026-04-11");
    assert.equal(result.rows[1].usage.input, 200);
    assert.equal(result.total.input, 300);
    assert.equal(result.total.assistantMessages, 2);
    assert.equal(result.total.sessionCount, 1);
  });

  it("skips clean sessions whose cursor is older than the requested history range", async () => {
    const state = makeState();
    const config = makeConfig();
    const oldCompletedAt = new Date(2026, 2, 1, 12).getTime();
    const currentCompletedAt = new Date(2026, 3, 12, 12).getTime();

    state.sessions.old = {
      createdAt: oldCompletedAt,
      baseTitle: "Old",
      lastAppliedTitle: undefined,
      cursor: { lastMessageTime: oldCompletedAt },
      dirty: false,
    };
    state.sessionDateMap.old = "2026-03-01";
    state.sessions.current = {
      createdAt: currentCompletedAt,
      baseTitle: "Current",
      lastAppliedTitle: undefined,
      cursor: { lastMessageTime: currentCompletedAt },
      dirty: false,
    };
    state.sessionDateMap.current = "2026-04-12";

    const requested: string[] = [];
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async (args: { path: { id: string } }) => {
            requested.push(args.path.id);
            if (args.path.id === "old") {
              throw new Error("old session should have been skipped");
            }
            return {
              data: [
                {
                  info: {
                    id: "m-current",
                    sessionID: "current",
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5",
                    time: {
                      created: currentCompletedAt,
                      completed: currentCompletedAt,
                    },
                    tokens: {
                      input: 50,
                      output: 10,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({ data: { all: [], default: {}, connected: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const realNow = Date.now;
    Date.now = () => new Date(2026, 3, 12, 23, 59, 59).getTime();
    try {
      const result = await service.summarizeHistoryUsage("day", "2026-04-12");
      assert.deepEqual(requested, ["current"]);
      assert.equal(result.total.assistantMessages, 1);
      assert.equal(result.total.input, 50);
    } finally {
      Date.now = realNow;
    }
  });

  it("keeps session measured cost root-only while apiCost includes children", async () => {
    const state = makeState();
    const config = makeConfig();
    config.sidebar.includeChildren = true;

    state.sessions.root = {
      createdAt: Date.now() - 2_000,
      baseTitle: "Root",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessions.child = {
      createdAt: Date.now() - 1_000,
      baseTitle: "Child",
      lastAppliedTitle: undefined,
      parentID: "root",
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap.root = "2026-01-01";
    state.sessionDateMap.child = "2026-01-01";

    const now = Date.now();
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async (args: { path: { id: string } }) => {
            if (args.path.id === "root") {
              return {
                data: [
                  {
                    info: {
                      id: "m-root",
                      sessionID: "root",
                      role: "assistant",
                      providerID: "openai",
                      modelID: "gpt-5",
                      time: { created: now - 100, completed: now - 90 },
                      tokens: {
                        input: 100,
                        output: 20,
                        reasoning: 0,
                        cache: { read: 50, write: 0 },
                      },
                      cost: 1.25,
                    },
                  },
                ],
              };
            }
            return {
              data: [
                {
                  info: {
                    id: "m-child",
                    sessionID: "child",
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5",
                    time: { created: now - 50, completed: now - 40 },
                    tokens: {
                      input: 50,
                      output: 10,
                      reasoning: 5,
                      cache: { read: 25, write: 25 },
                    },
                    cost: 9.99,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-5": {
                      id: "gpt-5",
                      cost: {
                        input: 0.0005,
                        output: 0.001,
                        cache_read: 0.00025,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => ["child"],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay("root", true);

    assert.equal(usage.input, 150);
    assert.equal(usage.output, 35);
    assert.equal(usage.total, 285);
    assert.equal(usage.sessionCount, 2);
    assert.equal(usage.cost, 1.25);
    assert.equal(usage.providers.openai.cost, 1.25);
    assert.ok(Math.abs(usage.apiCost - 0.12875) < 1e-9);
    assert.ok(Math.abs(usage.providers.openai.apiCost - 0.12875) < 1e-9);

    const metrics = getCacheCoverageMetrics(usage);
    assert.ok(Math.abs((metrics.cachedRatio || 0) - 0.3333333333333333) < 1e-9);
  });

  it("maps openai-compatible third-party providers to OpenAI pricing", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "openai-compatible-session";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "OpenAI compatible",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-rc-openai",
                  sessionID,
                  role: "assistant",
                  providerID: "rightcode-openai",
                  modelID: "gpt-5",
                  time: {
                    created: completedAt - 20,
                    completed: completedAt - 10,
                  },
                  tokens: {
                    input: 100,
                    output: 20,
                    reasoning: 0,
                    cache: { read: 50, write: 0 },
                  },
                  cost: 0,
                },
              },
              {
                info: {
                  id: "m-openai",
                  sessionID,
                  role: "assistant",
                  providerID: "openai",
                  modelID: "gpt-5",
                  time: { created: completedAt - 5, completed: completedAt },
                  tokens: {
                    input: 50,
                    output: 10,
                    reasoning: 0,
                    cache: { read: 25, write: 0 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-5": {
                      id: "gpt-5",
                      cost: {
                        input: 0.0005,
                        output: 0.001,
                        cache_read: 0.00025,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.ok(Math.abs(usage.apiCost - 0.12375) < 1e-9);
    assert.ok(
      Math.abs(usage.providers["rightcode-openai"].apiCost - 0.0825) < 1e-9,
    );
    assert.ok(Math.abs(usage.providers.openai.apiCost - 0.04125) < 1e-9);
  });

  it("schedules save for refreshed root usage even when includeChildren has no descendants", async () => {
    const state = makeState();
    const config = makeConfig();
    config.sidebar.includeChildren = true;
    const sessionID = "solo";

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: "Solo",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let saveCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({ data: [entry(sessionID, "m1", 10)] }),
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {
          saveCalls++;
        },
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      true,
    );

    assert.equal(usage.input, 10);
    assert.equal(saveCalls, 1);
    assert.ok(state.sessions[sessionID].usage);
  });

  it("forces a full rescan when cached billing version is stale", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "s1";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: 0,
        input: 999,
        output: 999,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1998,
        cost: 99,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 999,
            output: 999,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1998,
            cost: 99,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "m1",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["m1"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m1",
                  sessionID,
                  role: "assistant",
                  providerID: "openai",
                  modelID: "gpt-5",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 10,
                    output: 5,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  cost: 0.2,
                },
              },
            ],
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.input, 10);
    assert.equal(usage.output, 5);
    assert.equal(usage.cost, 0.2);
    assert.equal(
      state.sessions[sessionID].usage?.billingVersion,
      USAGE_BILLING_CACHE_VERSION,
    );
  });

  it("prefers explicit read-only providers over claude model heuristic", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "s1";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m1",
                  sessionID,
                  role: "assistant",
                  providerID: "openrouter",
                  modelID: "claude-3.7-sonnet",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100,
                    output: 10,
                    reasoning: 0,
                    cache: { read: 50, write: 0 },
                  },
                  cost: 0.2,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );
    const metrics = getCacheCoverageMetrics(usage);

    assert.equal(metrics.cachedRatio, 50 / 150);
  });

  it("recomputes stale-version cached usage when apiCost was previously zero", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "s1";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 100,
            output: 20,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 120,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "old",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["old"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "old",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 100,
                      output: 20,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-5": {
                      id: "gpt-5",
                      cost: {
                        input: 0.0005,
                        output: 0.001,
                        cache_read: 0.00025,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(usage.apiCost > 0);
    assert.ok(state.sessions[sessionID].usage?.apiCost);
  });

  it("matches anthropic api cost when message and pricing use different claude IDs", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "anthropic-session";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Anthropic Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-anthropic",
                  sessionID,
                  role: "assistant",
                  providerID: "anthropic",
                  modelID: "claude-3.7-sonnet",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-3-7-sonnet-20250219": {
                      id: "claude-3-7-sonnet-20250219",
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.providers.anthropic?.assistantMessages, 1);
    assert.ok(Math.abs(usage.apiCost - 0.7275) < 1e-9);
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 0.7275) < 1e-9,
    );
  });

  it("matches current opencode anthropic names with prefix and thinking suffix", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "anthropic-current";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Anthropic Current",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-anthropic-current",
                  sessionID,
                  role: "assistant",
                  providerID: "anthropic",
                  modelID: "anthropic/claude-sonnet-4-5-20250929-thinking",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4-5": {
                      id: "claude-sonnet-4-5",
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.providers.anthropic?.assistantMessages, 1);
    assert.ok(Math.abs(usage.apiCost - 0.7275) < 1e-9);
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 0.7275) < 1e-9,
    );
  });

  it("matches current opencode anthropic vertex and bedrock style IDs", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "anthropic-platforms";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Anthropic Platforms",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-vertex",
                  sessionID,
                  role: "assistant",
                  providerID: "anthropic",
                  modelID: "claude-sonnet-4-5@20250929",
                  time: {
                    created: completedAt - 20,
                    completed: completedAt - 10,
                  },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
              {
                info: {
                  id: "m-bedrock",
                  sessionID,
                  role: "assistant",
                  providerID: "anthropic",
                  modelID: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
                  time: { created: completedAt - 9, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4-5": {
                      id: "claude-sonnet-4-5",
                      cost: {
                        input: 3,
                        output: 15,
                        cache_read: 0.3,
                        cache_write: 3.75,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.providers.anthropic?.assistantMessages, 2);
    assert.ok(Math.abs(usage.apiCost - 1.455) < 1e-9);
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 1.455) < 1e-9,
    );
  });

  it("falls back to bundled Anthropic pricing when runtime metadata reports zero cost", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "anthropic-zero-cost";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Anthropic Zero Cost",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-anthropic-zero",
                  sessionID,
                  role: "assistant",
                  providerID: "anthropic",
                  modelID: "claude-opus-4-6",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-opus-4-6": {
                      id: "claude-opus-4-6",
                      cost: {
                        input: 0,
                        output: 0,
                        cache: { read: 0, write: 0 },
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.providers.anthropic?.assistantMessages, 1);
    assert.ok(Math.abs(usage.apiCost - 1.2125) < 1e-9);
    assert.ok(
      Math.abs((usage.providers.anthropic?.apiCost || 0) - 1.2125) < 1e-9,
    );
  });

  it("falls back to bundled OpenAI pricing when runtime metadata reports zero cost", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "openai-zero-cost";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "OpenAI Zero Cost",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-openai-zero",
                  sessionID,
                  role: "assistant",
                  providerID: "openai",
                  modelID: "gpt-5",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 0 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-5": {
                      id: "gpt-5",
                      cost: {
                        input: 0,
                        output: 0,
                        cache: { read: 0, write: 0 },
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(usage.providers.openai?.assistantMessages, 1);
    assert.ok(Math.abs(usage.apiCost - 0.6375) < 1e-9);
    assert.ok(Math.abs((usage.providers.openai?.apiCost || 0) - 0.6375) < 1e-9);
  });

  it("reuses bundled Anthropic pricing for anthropic-compatible third-party providers", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "relay-anthropic-fallback";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Relay Anthropic Fallback",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-relay-anthropic-zero",
                  sessionID,
                  role: "assistant",
                  providerID: "relay-anthropic",
                  modelID: "claude-sonnet-4-6",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 10_000 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4-6": {
                      id: "claude-sonnet-4-6",
                      cost: {
                        input: 0,
                        output: 0,
                        cache: { read: 0, write: 0 },
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    const relayUsage = usage.providers["relay-anthropic"];
    assert.ok(relayUsage);
    assert.ok(Math.abs(usage.apiCost - 0.7275) < 1e-9);
    assert.ok(Math.abs(relayUsage.apiCost - 0.7275) < 1e-9);
  });

  it("maps kimi-for-coding k2p5 usage to Moonshot international pricing first", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "kimi-session";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Kimi Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "m-kimi",
                  sessionID,
                  role: "assistant",
                  providerID: "kimi-for-coding",
                  modelID: "k2p5",
                  time: { created: completedAt - 10, completed: completedAt },
                  tokens: {
                    input: 100_000,
                    output: 20_000,
                    reasoning: 5_000,
                    cache: { read: 50_000, write: 0 },
                  },
                  cost: 0,
                },
              },
            ],
          }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "moonshotai",
                  models: {
                    "kimi-k2.5": {
                      id: "kimi-k2.5",
                      cost: {
                        input: 0.6,
                        output: 3,
                        cache_read: 0.1,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );
    const kimiUsage = usage.providers["kimi-for-coding"];

    assert.ok(kimiUsage);
    assert.equal(usage.cost, 0);
    assert.equal(kimiUsage.cost, 0);
    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-9);
    assert.ok(Math.abs(kimiUsage.apiCost - 0.14) < 1e-9);

    const metrics = getCacheCoverageMetrics(usage);
    assert.equal(metrics.cachedRatio, 1 / 3);
  });

  it("recomputes stale kimi-for-coding usage when pricing is available via Moonshot alias", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "kimi-stale";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Kimi stale",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 100_000,
        output: 25_000,
        reasoning: 0,
        cacheRead: 50_000,
        cacheWrite: 0,
        total: 175_000,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          "kimi-for-coding": {
            input: 100_000,
            output: 25_000,
            reasoning: 0,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 175_000,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "old-kimi",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["old-kimi"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "old-kimi",
                    sessionID,
                    role: "assistant",
                    providerID: "kimi-for-coding",
                    modelID: "k2p5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 100_000,
                      output: 20_000,
                      reasoning: 5_000,
                      cache: { read: 50_000, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "moonshotai",
                  models: {
                    "kimi-k2.5": {
                      id: "kimi-k2.5",
                      cost: {
                        input: 0.6,
                        output: 3,
                        cache_read: 0.1,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-9);
    assert.ok(
      Math.abs(usage.providers["kimi-for-coding"].apiCost - 0.14) < 1e-9,
    );
  });

  it("recomputes stale kimi-for-coding usage from bundled international fallback pricing", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "kimi-bundled-stale";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Kimi bundled stale",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 100_000,
        output: 25_000,
        reasoning: 0,
        cacheRead: 50_000,
        cacheWrite: 0,
        total: 175_000,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          "kimi-for-coding": {
            input: 100_000,
            output: 25_000,
            reasoning: 0,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 175_000,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "old-kimi-bundled",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["old-kimi-bundled"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "old-kimi-bundled",
                    sessionID,
                    role: "assistant",
                    providerID: "kimi-for-coding",
                    modelID: "k2p5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 100_000,
                      output: 20_000,
                      reasoning: 5_000,
                      cache: { read: 50_000, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "moonshotai",
                  models: {
                    "kimi-k2.5": {
                      id: "kimi-k2.5",
                      cost: {
                        input: 0,
                        output: 0,
                        cache_read: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(Math.abs(usage.apiCost - 0.14) < 1e-9);
    assert.ok(
      Math.abs(usage.providers["kimi-for-coding"].apiCost - 0.14) < 1e-9,
    );
  });

  it("recomputes stale zhipu coding-plan usage when bundled fallback pricing is available", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "zhipu-stale";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Zhipu stale",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 28_629,
        output: 3_852,
        reasoning: 0,
        cacheRead: 30_976,
        cacheWrite: 0,
        total: 63_457,
        cost: 0,
        apiCost: 0,
        assistantMessages: 3,
        providers: {
          "zhipuai-coding-plan": {
            input: 28_629,
            output: 3_852,
            reasoning: 0,
            cacheRead: 30_976,
            cacheWrite: 0,
            total: 63_457,
            cost: 0,
            apiCost: 0,
            assistantMessages: 3,
          },
        },
      },
      cursor: {
        lastMessageId: "old-zhipu",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["old-zhipu"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "old-zhipu",
                    sessionID,
                    role: "assistant",
                    providerID: "zhipuai-coding-plan",
                    modelID: "glm-5.1",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 28_629,
                      output: 3_852,
                      reasoning: 0,
                      cache: { read: 30_976, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "zhipuai-coding-plan",
                  models: {
                    "glm-5.1": {
                      id: "glm-5.1",
                      cost: {
                        input: 0,
                        output: 0,
                        cache_read: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(Math.abs(usage.apiCost - 0.0471506) < 1e-9);
    assert.ok(
      Math.abs(usage.providers["zhipuai-coding-plan"].apiCost - 0.0471506) <
        1e-9,
    );
  });

  it("recomputes stale minimax coding-plan usage when bundled fallback pricing is available", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "minimax-stale";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "MiniMax stale",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        input: 50_000,
        output: 10_000,
        reasoning: 0,
        cacheRead: 20_000,
        cacheWrite: 5_000,
        total: 85_000,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          "minimax-cn-coding-plan": {
            input: 50_000,
            output: 10_000,
            reasoning: 0,
            cacheRead: 20_000,
            cacheWrite: 5_000,
            total: 85_000,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "old-minimax",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["old-minimax"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "old-minimax",
                    sessionID,
                    role: "assistant",
                    providerID: "minimax-cn-coding-plan",
                    modelID: "MiniMax-M2.5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 50_000,
                      output: 10_000,
                      reasoning: 0,
                      cache: { read: 20_000, write: 5_000 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "minimax-cn-coding-plan",
                  models: {
                    "MiniMax-M2.5": {
                      id: "MiniMax-M2.5",
                      cost: {
                        input: 0,
                        output: 0,
                        cache_read: 0,
                        cache_write: 0,
                      },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(Math.abs(usage.apiCost - 0.029475) < 1e-9);
    assert.ok(
      Math.abs(usage.providers["minimax-cn-coding-plan"].apiCost - 0.029475) <
        1e-9,
    );
  });

  it("recomputes current-version zhipu usage when bundled fallback pricing becomes available", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "z-ai-current";
    const completedAt = Date.now() - 100;

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1000,
      baseTitle: "Z-AI current",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION,
        input: 28_629,
        output: 3_852,
        reasoning: 0,
        cacheRead: 30_976,
        cacheWrite: 0,
        total: 63_457,
        cost: 0,
        apiCost: 0,
        assistantMessages: 1,
        providers: {
          "z-ai": {
            input: 28_629,
            output: 3_852,
            reasoning: 0,
            cacheRead: 30_976,
            cacheWrite: 0,
            total: 63_457,
            cost: 0,
            apiCost: 0,
            assistantMessages: 1,
          },
        },
      },
      cursor: {
        lastMessageId: "m-zai-current",
        lastMessageTime: completedAt,
        lastMessageIdsAtTime: ["m-zai-current"],
      },
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let messageCalls = 0;
    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "m-zai-current",
                    sessionID,
                    role: "assistant",
                    providerID: "z-ai",
                    modelID: "glm-5.1",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 28_629,
                      output: 3_852,
                      reasoning: 0,
                      cache: { read: 30_976, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const usage = await service.summarizeSessionUsageForDisplay(
      sessionID,
      false,
    );

    assert.equal(messageCalls, 1);
    assert.ok(Math.abs(usage.apiCost - 0.0471506) < 1e-9);
    assert.ok(Math.abs(usage.providers["z-ai"].apiCost - 0.0471506) < 1e-9);
  });

  it("fails session-only tool summary when messages cannot load and no cache exists", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "s1";

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            throw new Error("load failed");
          },
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    await assert.rejects(
      service.summarizeForTool("session", sessionID, false),
      /session usage unavailable: failed to load messages for s1/,
    );
  });

  it("does not reuse stale cached session usage when messages cannot load", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "stale-cache";

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION - 1,
        pricingFingerprint: "old",
        pricingKeys: ["openai:gpt-test-runtime"],
        input: 1000,
        output: 500,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1500,
        cost: 0,
        apiCost: 123,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1500,
            cost: 0,
            apiCost: 123,
            assistantMessages: 1,
          },
        },
      },
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            throw new Error("load failed");
          },
        },
        provider: {
          list: async () => ({ data: { all: [] } }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    await assert.rejects(
      service.summarizeForTool("session", sessionID, false),
      /session usage unavailable: failed to load messages for stale-cache/,
    );
  });

  it("does not reuse cached session usage when a dirty session cannot load", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "dirty-cache";

    state.sessions[sessionID] = {
      createdAt: Date.now() - 1_000,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      dirty: true,
      usage: {
        billingVersion: USAGE_BILLING_CACHE_VERSION,
        pricingFingerprint: "fp",
        pricingKeys: ["openai:gpt-test-runtime"],
        input: 1000,
        output: 500,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1500,
        cost: 0,
        apiCost: 0.004,
        assistantMessages: 1,
        providers: {
          openai: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1500,
            cost: 0,
            apiCost: 0.004,
            assistantMessages: 1,
          },
        },
      },
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            throw new Error("load failed");
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-test-runtime": {
                      id: "gpt-test-runtime",
                      cost: { input: 2, output: 4 },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    await assert.rejects(
      service.summarizeForTool("session", sessionID, false),
      /session usage unavailable: failed to load messages for dirty-cache/,
    );
  });

  it("reuses last successful runtime pricing when runtime pricing fetch degrades", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "runtime-priced";
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;

    try {
      state.sessions[sessionID] = {
        createdAt: now - 1_000,
        baseTitle: "Session",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      let runtimeAvailable = true;
      let messageCalls = 0;
      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => {
              messageCalls++;
              return {
                data: [
                  {
                    info: {
                      id: "m-runtime",
                      sessionID,
                      role: "assistant",
                      providerID: "openai",
                      modelID: "gpt-test-runtime",
                      time: { created: now - 20, completed: now - 10 },
                      tokens: {
                        input: 1000,
                        output: 500,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      },
                      cost: 0,
                    },
                  },
                ],
              };
            },
          },
          provider: {
            list: async () => {
              if (!runtimeAvailable) throw new Error("provider.list failed");
              return {
                data: {
                  all: [
                    {
                      id: "openai",
                      models: {
                        "gpt-test-runtime": {
                          id: "gpt-test-runtime",
                          cost: { input: 2, output: 4 },
                        },
                      },
                    },
                  ],
                },
              };
            },
          },
        } as any,
        directory: "ignored",
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const first = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.equal(messageCalls, 1);
      assert.ok(Math.abs(first.apiCost - 0.004) < 1e-12);

      runtimeAvailable = false;
      now += 31_000;
      service.markSessionDirty(sessionID);
      const second = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );

      assert.equal(messageCalls, 2);
      assert.ok(Math.abs(second.apiCost - 0.004) < 1e-12);
      assert.ok(
        Math.abs((state.sessions[sessionID].usage?.apiCost || 0) - 0.004) <
          1e-12,
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not reuse an in-flight computation after session becomes dirty", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "s1";
    const createdAt = Date.now() - 1000;
    state.sessions[sessionID] = {
      createdAt,
      baseTitle: "Session",
      lastAppliedTitle: undefined,
      parentID: undefined,
      usage: undefined,
      cursor: undefined,
    };
    state.sessionDateMap[sessionID] = "2026-01-01";

    let calls = 0;
    let unblockFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });

    const service = createUsageService({
      state,
      config,
      statePath: "ignored",
      client: {
        session: {
          messages: async () => {
            calls++;
            if (calls === 1) {
              await firstBlocked;
              return { data: [entry(sessionID, "m1", 10)] };
            }
            return { data: [entry(sessionID, "m2", 20)] };
          },
        },
      } as any,
      directory: "ignored",
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    });

    const p1 = service.summarizeSessionUsageForDisplay(sessionID, false);
    await delay(10);
    assert.equal(calls, 1);

    service.markSessionDirty(sessionID);
    const u2 = await service.summarizeSessionUsageForDisplay(sessionID, false);
    assert.equal(u2.input, 20);

    unblockFirst?.();
    await p1;
  });

  it("prefers opencode config pricing over runtime pricing and refreshes on non-zero price changes", async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "usage-service-pricing-"),
    );
    try {
      const state = makeState();
      const config = makeConfig();
      const sessionID = "config-priced";
      const completedAt = Date.now() - 100;
      const configPath = path.join(projectDir, "opencode.jsonc");

      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "Config priced",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      let messageCalls = 0;
      const client = {
        session: {
          messages: async () => {
            messageCalls++;
            return {
              data: [
                {
                  info: {
                    id: "m-config-priced",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            };
          },
        },
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-5": {
                      id: "gpt-5",
                      cost: { input: 20, output: 40, cache_read: 10 },
                    },
                  },
                },
              ],
            },
          }),
        },
      } as any;

      const writePricing = async (
        input: number,
        output: number,
        cacheRead: number,
      ) => {
        await fs.writeFile(
          configPath,
          `{
            // user-configured override should win over runtime pricing
            "provider": {
              "openai": {
                "models": {
                  "gpt-5": {
                    "id": "gpt-5",
                    "cost": { "input": ${input}, "output": ${output}, "cache_read": ${cacheRead} }
                  }
                }
              }
            }
          }`,
        );
      };

      const makeService = () =>
        createUsageService({
          state,
          config,
          statePath: "ignored",
          client,
          directory: projectDir,
          worktree: projectDir,
          persistence: {
            markDirty: () => {},
            scheduleSave: () => {},
            flushSave: async () => {},
          },
          descendantsResolver: {
            listDescendantSessionIDs: async () => [],
          },
        });

      await writePricing(2, 4, 1);
      const firstService = makeService();
      const first = await firstService.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );

      assert.equal(messageCalls, 1);
      assert.ok(Math.abs(first.apiCost - 0.004) < 1e-12);
      const firstFingerprint =
        state.sessions[sessionID].usage?.pricingFingerprint;

      await writePricing(3, 6, 1.5);
      const secondService = makeService();
      const second = await secondService.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );

      assert.equal(messageCalls, 2);
      assert.ok(Math.abs(second.apiCost - 0.006) < 1e-12);
      assert.notEqual(
        state.sessions[sessionID].usage?.pricingFingerprint,
        firstFingerprint,
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("derives runtime-only fast variants from higher-priority opencode base pricing", async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "usage-service-fast-pricing-"),
    );
    try {
      const state = makeState();
      const config = makeConfig();
      const sessionID = "config-fast-priced";
      const completedAt = Date.now() - 100;

      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "Config fast priced",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      await fs.writeFile(
        path.join(projectDir, "opencode.jsonc"),
        `{
          "provider": {
            "openai": {
              "models": {
                "gpt-5": {
                  "id": "gpt-5",
                  "cost": { "input": 3, "output": 6 }
                }
              }
            }
          }
        }`,
      );

      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "m-config-fast",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5-fast",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "openai",
                    models: {
                      "gpt-5": {
                        id: "gpt-5",
                        cost: { input: 4, output: 8 },
                      },
                      "gpt-5-fast": {
                        id: "gpt-5-fast",
                        cost: { input: 20, output: 40 },
                        options: { serviceTier: "priority" },
                        api: { id: "gpt-5" },
                      },
                    },
                  },
                ],
              },
            }),
          },
        } as any,
        directory: projectDir,
        worktree: projectDir,
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const usage = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.ok(Math.abs(usage.apiCost - 0.012) < 1e-12);
      assert.ok(Math.abs(usage.providers.openai.apiCost - 0.012) < 1e-12);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("applies canonical config pricing to alias provider runtime models", async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "usage-service-alias-pricing-"),
    );
    try {
      const state = makeState();
      const config = makeConfig();
      const sessionID = "alias-priced";
      const completedAt = Date.now() - 100;

      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "Alias priced",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      await fs.writeFile(
        path.join(projectDir, "opencode.jsonc"),
        `{
          "provider": {
            "zhipu-prod": {
              "id": "zhipu",
              "models": {
                "glm-5": {
                  "id": "glm-5",
                  "cost": { "input": 2, "output": 4, "cache_read": 1 }
                }
              }
            }
          }
        }`,
      );

      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "m-alias-priced",
                    sessionID,
                    role: "assistant",
                    providerID: "zhipuai-coding-plan",
                    modelID: "glm-5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 100, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "zhipuai-coding-plan",
                    models: {
                      "glm-5": {
                        id: "glm-5",
                        cost: { input: 10, output: 20, cache_read: 5 },
                      },
                    },
                  },
                ],
              },
            }),
          },
        } as any,
        directory: projectDir,
        worktree: projectDir,
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const usage = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.ok(Math.abs(usage.apiCost - 0.0041) < 1e-12);
      assert.ok(
        Math.abs(usage.providers["zhipuai-coding-plan"].apiCost - 0.0041) <
          1e-12,
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("does not query models.dev when bundled pricing already covers the runtime model", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "bundled-covered";
    const completedAt = Date.now() - 100;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    try {
      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "bundled covered",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
        fetchCalls++;
        return new Response("", { status: 404 });
      };

      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "m-bundled-covered",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "openai",
                    models: {
                      "gpt-5": {
                        id: "gpt-5",
                        cost: {
                          input: 0,
                          output: 0,
                          cache: { read: 0, write: 0 },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          },
        } as any,
        directory: "ignored",
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const usage = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.equal(fetchCalls, 0);
      assert.ok(usage.apiCost > 0);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("supplements missing runtime pricing from models.dev for exact models", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "models-dev-exact";
    const completedAt = Date.now() - 100;
    const originalFetch = globalThis.fetch;

    try {
      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "models.dev exact",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
        input: string | URL | Request,
      ) => {
        const url = String(input);
        if (/providers\/openai\/models\/gpt-5\.1\.toml$/.test(url)) {
          return new Response(
            `[cost]
input = 1.25
output = 10
cache_read = 0.125
`,
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      };

      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "m-models-dev-exact",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5.1",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 100, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "openai",
                    models: {
                      "gpt-5.1": {
                        id: "gpt-5.1",
                        cost: {
                          input: 0,
                          output: 0,
                          cache: { read: 0, write: 0 },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          },
        } as any,
        directory: "ignored",
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const usage = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.ok(Math.abs(usage.apiCost - 0.0062625) < 1e-12);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("derives fast-tier pricing from models.dev base pricing when runtime pricing is missing", async () => {
    const state = makeState();
    const config = makeConfig();
    const sessionID = "models-dev-fast";
    const completedAt = Date.now() - 100;
    const originalFetch = globalThis.fetch;

    try {
      state.sessions[sessionID] = {
        createdAt: Date.now() - 1000,
        baseTitle: "models.dev fast",
        lastAppliedTitle: undefined,
        parentID: undefined,
        usage: undefined,
        cursor: undefined,
      };
      state.sessionDateMap[sessionID] = "2026-01-01";

      (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
        input: string | URL | Request,
      ) => {
        const url = String(input);
        if (/providers\/openai\/models\/gpt-5\.1-fast\.toml$/.test(url)) {
          return new Response("", { status: 404 });
        }
        if (/providers\/openai\/models\/gpt-5\.1\.toml$/.test(url)) {
          return new Response(
            `[cost]
input = 1.25
output = 10
cache_read = 0.125
`,
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      };

      const service = createUsageService({
        state,
        config,
        statePath: "ignored",
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "m-models-dev-fast",
                    sessionID,
                    role: "assistant",
                    providerID: "openai",
                    modelID: "gpt-5.1-fast",
                    time: { created: completedAt - 10, completed: completedAt },
                    tokens: {
                      input: 1000,
                      output: 500,
                      reasoning: 0,
                      cache: { read: 100, write: 0 },
                    },
                    cost: 0,
                  },
                },
              ],
            }),
          },
          provider: {
            list: async () => ({
              data: {
                all: [
                  {
                    id: "openai",
                    models: {
                      "gpt-5.1-fast": {
                        id: "gpt-5.1-fast",
                        cost: {
                          input: 0,
                          output: 0,
                          cache: { read: 0, write: 0 },
                        },
                        options: { serviceTier: "priority" },
                        api: { id: "gpt-5.1" },
                      },
                    },
                  },
                ],
              },
            }),
          },
        } as any,
        directory: "ignored",
        persistence: {
          markDirty: () => {},
          scheduleSave: () => {},
          flushSave: async () => {},
        },
        descendantsResolver: {
          listDescendantSessionIDs: async () => [],
        },
      });

      const usage = await service.summarizeSessionUsageForDisplay(
        sessionID,
        false,
      );
      assert.ok(Math.abs(usage.apiCost - 0.012525) < 1e-12);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});
