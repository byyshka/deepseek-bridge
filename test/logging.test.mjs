// Logging is off by default because the record holds prompts and answers verbatim. Both halves of
// that promise are worth a test: nothing is written unless asked, and when asked the record is
// actually usable.
//
// The flag is read once at module load, so each case runs the server as a child process with its
// own environment rather than toggling a variable in-process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "index.mjs");
const fixture = path.join(here, "..", "fixtures", "fake-dsh.mjs");

// Runs one tools/call through a freshly started server and returns its log directory.
function callWith(env) {
  const logDir = mkdtempSync(path.join(os.tmpdir(), "bridge-log-"));
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "deepseek_ask", arguments: { prompt: "say ok", cwd: here } },
    },
  ];

  const result = spawnSync(process.execPath, [server], {
    input: requests.map((request) => `${JSON.stringify(request)}\n`).join(""),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      DSH_BIN: fixture,
      DEEPSEEK_API_KEY: "test-key-not-used-by-the-fixture",
      DEEPSEEK_BRIDGE_LOG_DIR: logDir,
      ...env,
    },
  });

  assert.match(result.stdout, /"result"/, `the call did not succeed: ${result.stderr}`);

  return logDir;
}

test("nothing is written unless logging is switched on", () => {
  const logDir = callWith({ DEEPSEEK_BRIDGE_LOG: "0" });

  try {
    assert.deepEqual(readdirSync(logDir), [], "a log file appeared with logging off");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("an unset flag also means no log — off is the default, not an opt-out", () => {
  const logDir = callWith({ DEEPSEEK_BRIDGE_LOG: undefined });

  try {
    assert.deepEqual(readdirSync(logDir), []);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("with the flag on, the call is recorded in a readable form", () => {
  const logDir = callWith({ DEEPSEEK_BRIDGE_LOG: "1" });

  try {
    const files = readdirSync(logDir);

    assert.equal(files.length, 1, `expected one log file, got ${JSON.stringify(files)}`);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = readFileSync(path.join(logDir, files[0]), "utf8").trim().split("\n");

    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);

    assert.equal(entry.status, "ok");
    assert.equal(entry.answer, "ok");
    assert.equal(entry.prompt, "say ok");
    assert.equal(entry.exit_code, 0);
    assert.ok(typeof entry.duration_ms === "number");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
