#!/usr/bin/env node
// deepseek-bridge — exposes the locally installed DeepSeek Harness (DSH) to Claude Code as an MCP tool.
//
// Design notes (Windows-specific, deliberate):
//   * DSH was installed by DSH Desktop, so there is no `dsh` on PATH and nothing in npm global.
//     The CLI profiles live in %USERPROFILE%\.dsh; we spawn its lib/bin.js through node.exe.
//     Spawning a .cmd shim would force shell:true and break argv escaping for prompts
//     containing quotes, newlines or Cyrillic.
//   * The `headless` profile answers one task, prints the final assistant message on stdout,
//     streams reasoning to stderr, and exits. No NDJSON parsing is needed, unlike kimi-bridge.
//   * Desktop keeps its own credential store; the CLI profile does NOT inherit it and fails with
//     MISSING_CREDENTIAL. DEEPSEEK_API_KEY must be present in the child environment.
//   * The headless profile takes the task as a positional argv entry and offers no --prompt-file,
//     so long prompts are rejected up front rather than dying with ENAMETOOLONG at 32767 chars.
//
// Why cwd matters: dsh-agent-instructions loads AGENTS.md / CLAUDE.md / RULES.md walking
// projectRoot -> cwd. Launched outside the project, DSH answers without our standards. The default
// below keeps every call inside the project unless the caller deliberately overrides it.
//
// No session/resume support: the headless profile exposes no --resume. Multi-turn belongs to the
// tui profile and is deliberately out of scope here.

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { spawn, execFileSync } from "node:child_process"; // execFileSync is used by killTree
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Read the version rather than repeating it: a copy in the source silently drifts from package.json.
const { version: VERSION } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_PROMPT_CHARS = 28000; // argv ceiling on Windows is 32767 for the whole command line
const DEFAULT_CWD = process.env.DEEPSEEK_BRIDGE_CWD || process.cwd();
const LOG_DIR = process.env.DEEPSEEK_BRIDGE_LOG_DIR || path.join(import.meta.dirname, "logs");

// Off by default: the log records prompts and answers verbatim, which on someone else's machine
// means their data on disk without them ever asking for it. Opt in with DEEPSEEK_BRIDGE_LOG=1.
const LOGGING_ENABLED = process.env.DEEPSEEK_BRIDGE_LOG === "1";

// DSH arrives by several routes — the Desktop app keeps its CLI profiles under $DSH_HOME, while a
// plain `npm i -g @deepseek-ai/dsh` puts the package in the global root, which differs again under
// nvm, fnm or volta. Probe the known layouts instead of assuming one, and let DSH_BIN win outright.
function dshEntryCandidates() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const tail = path.join("@deepseek-ai", "dsh", "lib", "bin.js");
  const candidates = [path.join(home, "profiles", "node_modules", tail)];

  // Derive the global node_modules from the running node instead of shelling out to `npm root -g`:
  // no subprocess, no deprecation warning on the server's stderr, and it follows whichever install
  // is active under nvm, fnm or volta.
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    candidates.push(path.join(nodeDir, "node_modules", tail));

    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", tail));
    }
  } else {
    candidates.push(path.join(path.dirname(nodeDir), "lib", "node_modules", tail));
    candidates.push(path.join("/usr/local/lib/node_modules", tail));
    candidates.push(path.join(os.homedir(), ".local", "lib", "node_modules", tail));
  }

  return [...new Set(candidates)];
}

function resolveDshEntry() {
  const override = process.env.DSH_BIN;

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`DSH_BIN points at a missing file: ${override}`);
    }

    return override;
  }

  const candidates = dshEntryCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new Error(
      "DeepSeek Harness entry point not found. Looked in:\n" +
        candidates.map((candidate) => `  ${candidate}`).join("\n") +
        "\nInstall it (npm i -g @deepseek-ai/dsh) or point DSH_BIN at its lib/bin.js.",
    );
  }

  return found;
}

function writeLog(entry) {
  if (!LOGGING_ENABLED) {
    return;
  }

  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);

    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never break a call.
  }
}

// stderr carries "dsh: reasoning:" blocks and, on failure, the actual diagnosis
// (MISSING_CREDENTIAL and friends). Keep it for the log and for error messages.
function extractFailureHint(stderr) {
  const line = stderr
    .split(/\r?\n/)
    .find((candidate) => /dsh:\s*[A-Z_]+:/.test(candidate));

  return line ? line.trim() : null;
}

// Children still running, so they can be cleaned up if this server goes down mid-call.
const liveChildren = new Set();

// child.kill() signals only the node wrapper we spawned; DSH starts its own children, and those
// survive as orphans still holding an API session. Windows has no process group to signal, so the
// whole tree goes through taskkill /T.
function killTree(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });

      return;
    } catch {
      // taskkill can fail if the process already exited — fall through to the direct kill.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

function killAllChildren() {
  for (const child of liveChildren) {
    killTree(child);
  }
}

// On "exit" only synchronous cleanup is possible, and calling process.exit there would recurse.
process.on("exit", killAllChildren);

// A signal handler replaces the default action, so the process would otherwise keep running and
// ignore Ctrl+C. Clean up, then exit with the conventional 128 + signal number.
process.on("SIGINT", () => {
  killAllChildren();
  process.exit(130);
});

process.on("SIGTERM", () => {
  killAllChildren();
  process.exit(143);
});

function runDsh({ prompt, cwd, timeoutSec }) {
  const entry = resolveDshEntry();
  const workingDir = cwd || DEFAULT_CWD;

  if (!existsSync(workingDir)) {
    return Promise.reject(new Error(`cwd does not exist: ${workingDir}`));
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return Promise.reject(
      new Error(
        "DEEPSEEK_API_KEY is not set for this server. The DSH CLI profile does not inherit the key " +
          "stored by DSH Desktop and will fail with MISSING_CREDENTIAL. Add it to the server's env block.",
      ),
    );
  }

  const args = [entry, "--profile", "headless", prompt];
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workingDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    liveChildren.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const baseLog = () => ({
      ts: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      cwd: workingDir,
      prompt_chars: prompt.length,
      prompt: prompt.slice(0, 2000),
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      writeLog({ ...baseLog(), status: "spawn_error", error: error.message });
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);

      const answer = stdout.trim();
      const log = {
        ...baseLog(),
        exit_code: code,
        timed_out: timedOut,
        answer_chars: answer.length,
        stderr_chars: stderr.length,
      };

      // A timeout truncates the answer even when text was produced — never report a killed
      // call as a clean result.
      if (timedOut) {
        writeLog({ ...log, status: "timeout", partial_answer: answer || null, stderr: stderr.slice(0, 4000) });

        reject(
          new Error(
            `DSH was killed by the ${timeoutSec}s timeout. ` +
              (answer
                ? `Partial output (${answer.length} chars) was produced` +
                  (LOGGING_ENABLED
                    ? " and kept in the log — treat it as incomplete."
                    : " and discarded; set DEEPSEEK_BRIDGE_LOG=1 to keep partial output.")
                : "No answer had been produced."),
          ),
        );
        return;
      }

      if (!answer) {
        const hint = extractFailureHint(stderr);

        writeLog({ ...log, status: "no_answer", stderr: stderr.slice(0, 4000) });

        reject(
          new Error(
            `DSH returned no answer (exit ${code}).` +
              (hint ? `\n${hint}` : "") +
              `\nstderr: ${stderr.slice(0, 2000) || "(empty)"}`,
          ),
        );
        return;
      }

      writeLog({ ...log, status: "ok", answer: answer.slice(0, 8000) });

      resolve({
        answer,
        reasoning: stderr.trim(),
        exitCode: code,
        durationMs: Date.now() - startedAt,
        cwd: workingDir,
      });
    });
  });
}

function formatResult(result, includeReasoning) {
  const parts = [result.answer];
  const footer = [`Took ${(result.durationMs / 1000).toFixed(1)}s in ${result.cwd}.`];

  // The headless profile does not report tool calls on stderr, so this bridge cannot list them
  // the way kimi-bridge does. Say so rather than implying the answer was verified.
  if (result.reasoning) {
    footer.push(
      `DSH produced ${result.reasoning.length} chars of reasoning on stderr. ` +
        "Tool calls are NOT reported by the headless profile — if the answer states a fact about " +
        "this codebase, confirm it was read rather than recalled.",
    );
  } else {
    footer.push("No reasoning on stderr — likely answered directly, without inspecting anything.");
  }

  if (result.exitCode !== 0) {
    footer.push(`Exit code was ${result.exitCode} despite an answer — treat the result with care.`);
  }

  if (includeReasoning && result.reasoning) {
    parts.push(`\n--- reasoning (stderr) ---\n${result.reasoning}`);
  }

  parts.push(`\n---\n${footer.join("\n")}`);

  return parts.join("\n");
}

const ASK_DESCRIPTION = [
  "Delegate one self-contained task to DeepSeek through the locally installed DeepSeek Harness (DSH).",
  "",
  "DSH runs as its own agent: it reads AGENTS.md / CLAUDE.md / RULES.md from the project and opens",
  "files itself. Name the files in the prompt instead of pasting their contents — that is the whole",
  "point, since their text then never enters this conversation's context.",
  "",
  "Best for bulk, cheap, read-heavy work: summarising large files, extracting data, drafting,",
  "translating, routine passes over many files. It is a separate model, so its claims about this",
  "codebase are evidence only insofar as it actually read the files.",
  "",
  "One shot per call — there is no session to resume. State everything the task needs.",
].join("\n");

const server = new McpServer({ name: "deepseek-bridge", version: VERSION });

server.registerTool(
  "deepseek_ask",
  {
    description: ASK_DESCRIPTION,
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "The full, self-contained task. Name files by path rather than pasting them. " +
            `Hard limit ${MAX_PROMPT_CHARS} chars (Windows argv ceiling).`,
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          `Working directory. Defaults to ${DEFAULT_CWD}. DSH loads project rules by walking ` +
            "projectRoot -> cwd, so pointing this outside the project drops our standards.",
        ),
      timeout_sec: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Wall-clock limit for the run. Default ${DEFAULT_TIMEOUT_SEC}.`),
      include_reasoning: z
        .boolean()
        .optional()
        .describe("Append DSH's stderr reasoning to the answer. Off by default; useful when debugging a bad answer."),
    },
  },
  async ({ prompt, cwd, timeout_sec, include_reasoning }) => {
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `Prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS} limit. The headless profile takes ` +
          "the task through argv and offers no --prompt-file. Name files by path instead of pasting them.",
      );
    }

    const result = await runDsh({
      prompt,
      cwd,
      timeoutSec: timeout_sec || DEFAULT_TIMEOUT_SEC,
    });

    return { content: [{ type: "text", text: formatResult(result, include_reasoning === true) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(
    `deepseek-bridge ${VERSION} on stdio, default cwd: ${DEFAULT_CWD} ` +
      `(logs: ${LOGGING_ENABLED ? LOG_DIR : "disabled"})`,
  );
}

// Compare real paths, not URLs. When this file is reached through a symlink or junction, Node
// resolves import.meta.url to the link TARGET while argv[1] keeps the path as spawned. A plain URL
// comparison is then false and the server exits 0 without ever starting — a silent no-op, not an
// error. Paths are compared case-insensitively on Windows, where realpathSync keeps the case it
// was handed and the same file can arrive as c:\... or C:\...
function startedDirectly() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const entry = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(import.meta.url));

    // Windows paths are case-insensitive while realpathSync preserves the case it was handed,
    // so the same file reached as c:\... and C:\... compares unequal on a strict ===.
    if (process.platform === "win32") {
      return entry.toLowerCase() === self.toLowerCase();
    }

    return entry === self;
  } catch (error) {
    // Never fail silently: an unresolvable path would exit 0 with no output, which is the exact
    // failure mode this predicate was rewritten to remove.
    console.error(`deepseek-bridge: cannot resolve entry path, not starting — ${error.message}`);

    return false;
  }
}

if (startedDirectly()) {
  main().catch((error) => {
    console.error("Fatal error in deepseek-bridge:", error);
    process.exit(1);
  });
}

export { resolveDshEntry, formatResult, extractFailureHint };
