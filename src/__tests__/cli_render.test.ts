import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cliCurrentLabel,
  renderCliDashboard,
  renderCliHistoryDashboard,
} from "../cli_render.js";

function usage(overrides: Record<string, unknown> = {}) {
  return {
    input: 1200,
    output: 3400,
    reasoning: 0,
    cacheRead: 800,
    cacheWrite: 0,
    total: 5400,
    cost: 0,
    apiCost: 1.25,
    assistantMessages: 12,
    sessionCount: 1,
    providers: {
      openai: {
        providerID: "openai",
        input: 1200,
        output: 3400,
        reasoning: 0,
        cacheRead: 800,
        cacheWrite: 0,
        total: 5400,
        cost: 0,
        apiCost: 1.25,
        assistantMessages: 12,
      },
    },
    ...overrides,
  };
}

describe("cli renderers", () => {
  it("renders current-period dashboard sections", () => {
    const output = renderCliDashboard({
      label: cliCurrentLabel("day"),
      usage: usage() as never,
      quotas: [
        {
          providerID: "openai",
          label: "OpenAI",
          status: "ok",
          checkedAt: Date.now(),
          windows: [{ label: "5h", remainingPercent: 72 }],
        },
      ],
    });

    assert.match(output, /opencode-quota · Today/);
    assert.match(output, /QUOTA/);
    assert.match(output, /TOTALS/);
    assert.match(output, /PROVIDERS/);
    assert.match(output, /OpenAI/);
  });

  it("renders history dashboard trend section", () => {
    const output = renderCliHistoryDashboard({
      result: {
        period: "day",
        since: { raw: "2026-02-18", precision: "day", startAt: 0 },
        rows: [
          {
            range: {
              period: "day",
              startAt: 0,
              endAt: 1,
              label: "2026-02-18",
              shortLabel: "02-18",
              isCurrent: false,
              isPartial: false,
              index: 0,
            },
            usage: usage({
              assistantMessages: 4,
              total: 2000,
              apiCost: 0.5,
            }) as never,
          },
          {
            range: {
              period: "day",
              startAt: 1,
              endAt: 2,
              label: "2026-02-19",
              shortLabel: "02-19",
              isCurrent: true,
              isPartial: true,
              index: 1,
            },
            usage: usage() as never,
          },
        ],
        total: usage({
          assistantMessages: 16,
          total: 7400,
          apiCost: 1.75,
        }) as never,
      },
      quotas: [],
    });

    assert.match(output, /opencode-quota · Daily since 2026-02-18/);
    assert.match(output, /TREND/);
    assert.match(output, /Requests 12/);
    assert.match(output, /Tokens 5\.4k/);
    assert.match(output, /Cache 40%/);
    assert.match(output, /API Cost \$1\.25/);
    assert.match(output, /02-18\s+\|\s+█+/);
    assert.match(output, /02-19\*\s+\|\s+█+/);
  });

  it("respects showCost=false and avoids cost rows", () => {
    const output = renderCliDashboard({
      label: cliCurrentLabel("week"),
      usage: usage() as never,
      quotas: [],
      showCost: false,
    });

    assert.doesNotMatch(output, /API Cost \$/);
    assert.doesNotMatch(output, /\$1\.25/);
  });

  it("does not duplicate non-percent quota labels in CLI rows", () => {
    const output = renderCliDashboard({
      label: cliCurrentLabel("day"),
      usage: usage() as never,
      quotas: [
        {
          providerID: "rightcode-openai",
          adapterID: "rightcode",
          label: "RightCode",
          shortLabel: "RC-openai",
          status: "ok",
          checkedAt: Date.now(),
          windows: [{ label: "Daily $88.9/$60", showPercent: false }],
        },
      ],
    });

    assert.match(output, /Daily \$88\.9\/\$60/);
    assert.doesNotMatch(output, /Daily \$88\.9\/\$60Daily \$88\.9\/\$60/);
  });

  it("suppresses Copilot API cost in CLI summaries and provider rows", () => {
    const output = renderCliDashboard({
      label: cliCurrentLabel("day"),
      usage: usage({
        apiCost: 0.45,
        providers: {
          "github-copilot": {
            providerID: "github-copilot",
            input: 50,
            output: 80,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 130,
            cost: 0,
            apiCost: 0.45,
            assistantMessages: 2,
          },
        },
      }) as never,
      quotas: [],
    });

    assert.match(output, /API Cost -/);
    assert.doesNotMatch(output, /\$0\.45/);
  });
});
