import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cliBaseUrl,
  cliExitCodeForError,
  extractCliServerUrl,
  releaseCliServerProcess,
  terminateCliServerProcess,
  cliServerCommandCandidates,
  cliShouldRunMain,
  parseCliArgs,
} from "../cli.js";

describe("parseCliArgs", () => {
  it("parses current natural period commands", () => {
    assert.deepEqual(parseCliArgs(["day"]), { period: "day" });
    assert.deepEqual(parseCliArgs(["week"]), { period: "week" });
    assert.deepEqual(parseCliArgs(["month"]), { period: "month" });
  });

  it("parses positional last arguments", () => {
    assert.deepEqual(parseCliArgs(["day", "7"]), { period: "day", last: 7 });
    assert.deepEqual(parseCliArgs(["week", "8"]), { period: "week", last: 8 });
    assert.deepEqual(parseCliArgs(["month", "6"]), {
      period: "month",
      last: 6,
    });
  });

  it("parses positional and flag since arguments", () => {
    assert.deepEqual(parseCliArgs(["day", "2026-04-01"]), {
      period: "day",
      since: "2026-04-01",
    });
    assert.deepEqual(parseCliArgs(["month", "--since", "2026-01"]), {
      period: "month",
      since: "2026-01",
    });
  });

  it("rejects invalid combinations", () => {
    assert.throws(
      () => parseCliArgs(["day", "7", "--since", "2026-04-01"]),
      /Cannot use both since and last/,
    );
    assert.throws(
      () => parseCliArgs(["month", "--since", "2026-04-01"]),
      /YYYY-MM/,
    );
    assert.throws(() => parseCliArgs(["year"]), /Unknown period/);
  });

  it("returns exit code 0 only for explicit help text", () => {
    const helpError = (() => {
      try {
        parseCliArgs(["--help"]);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    const invalidError = (() => {
      try {
        parseCliArgs(["year"]);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    assert.equal(cliExitCodeForError(helpError), 0);
    assert.equal(cliExitCodeForError(invalidError), 1);
  });

  it("uses localhost API by default and allows override", () => {
    const original = process.env.OPENCODE_BASE_URL;
    try {
      delete process.env.OPENCODE_BASE_URL;
      assert.equal(cliBaseUrl(), "http://localhost:4096");
      process.env.OPENCODE_BASE_URL = "http://127.0.0.1:7777";
      assert.equal(cliBaseUrl(), "http://127.0.0.1:7777");
    } finally {
      if (original === undefined) delete process.env.OPENCODE_BASE_URL;
      else process.env.OPENCODE_BASE_URL = original;
    }
  });

  it("uses platform-specific server startup candidates", () => {
    assert.deepEqual(cliServerCommandCandidates("linux"), [
      {
        command: "opencode",
        args: ["serve", "--hostname=127.0.0.1", "--port=4096"],
      },
    ]);

    const win = cliServerCommandCandidates("win32");
    assert.equal(win[0]?.command, "opencode.cmd");
    assert.equal(
      win[1]?.command,
      "opencode serve --hostname=127.0.0.1 --port=4096",
    );
    assert.equal(win[1]?.shell, true);
    assert.equal(win[2]?.command, "bash");
  });

  it("treats symlinked bin paths as the CLI entrypoint", () => {
    const modulePath = "/pkg/dist/cli.js";
    const symlinkPath = "/usr/local/bin/opencode-quota";
    const resolvePath = (value: string) =>
      value === symlinkPath ? modulePath : value;

    assert.equal(cliShouldRunMain(symlinkPath, modulePath, resolvePath), true);
    assert.equal(
      cliShouldRunMain("/tmp/other.js", modulePath, resolvePath),
      false,
    );
    assert.equal(cliShouldRunMain(undefined, modulePath, resolvePath), false);
  });

  it("releases child process pipes and unrefs it", () => {
    let stdinDestroyed = false;
    let stdoutDestroyed = false;
    let stderrDestroyed = false;
    let unrefCalled = false;

    releaseCliServerProcess({
      stdin: {
        destroy: () => {
          stdinDestroyed = true;
        },
      },
      stdout: {
        destroy: () => {
          stdoutDestroyed = true;
        },
      },
      stderr: {
        destroy: () => {
          stderrDestroyed = true;
        },
      },
      unref: () => {
        unrefCalled = true;
      },
    });

    assert.equal(stdinDestroyed, true);
    assert.equal(stdoutDestroyed, true);
    assert.equal(stderrDestroyed, true);
    assert.equal(unrefCalled, true);
  });

  it("terminates unix temp servers by process group", () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    let childKillCalled = false;

    terminateCliServerProcess(
      {
        pid: 4321,
        killed: false,
        kill: () => {
          childKillCalled = true;
          return true;
        },
        stdin: { destroy: () => {} },
        stdout: { destroy: () => {} },
        stderr: { destroy: () => {} },
        unref: () => {},
      },
      {
        platform: "linux",
        killProcess: ((pid: number, signal?: string | number) => {
          killed.push({ pid, signal: String(signal) });
          return true;
        }) as typeof process.kill,
      },
    );

    assert.deepEqual(killed, [{ pid: -4321, signal: "SIGTERM" }]);
    assert.equal(childKillCalled, false);
  });

  it("falls back to direct child termination when group kill is unavailable", () => {
    let childKillSignal: string | undefined;

    terminateCliServerProcess(
      {
        pid: 4321,
        killed: false,
        kill: (signal?: string) => {
          childKillSignal = signal;
          return true;
        },
        stdin: { destroy: () => {} },
        stdout: { destroy: () => {} },
        stderr: { destroy: () => {} },
        unref: () => {},
      },
      {
        platform: "linux",
        killProcess: (() => {
          throw new Error("ESRCH");
        }) as typeof process.kill,
      },
    );

    assert.equal(childKillSignal, "SIGTERM");
  });

  it("extracts the listen URL from linux-style direct output", () => {
    const output = [
      "booting",
      "opencode server listening on http://127.0.0.1:4096",
      "ready",
    ].join("\n");

    assert.equal(extractCliServerUrl(output), "http://127.0.0.1:4096");
  });

  it("extracts the listen URL from windows shell fallback output", () => {
    const output = [
      "Microsoft Windows [Version 10.0.26100.0]",
      "opencode server listening on http://127.0.0.1:4096",
    ].join("\n");

    assert.equal(extractCliServerUrl(output), "http://127.0.0.1:4096");
  });

  it("ignores output before the listen line appears", () => {
    const partial = "starting server...";
    assert.equal(extractCliServerUrl(partial), undefined);
  });
});
