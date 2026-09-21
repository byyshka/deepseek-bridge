# deepseek-bridge

An MCP server that hands bulk, read-heavy work from Claude Code to a **DeepSeek Harness** agent
running on the same machine.

The point is not "another model to chat with". DSH is a full agent: it opens files itself, so you
name paths in the prompt instead of pasting contents. The text of those files never enters Claude's
context — you pay context only for the instruction and the answer.

Measured on a 30 KB Markdown file: 14 seconds, correct answer, zero bytes of the file in Claude's
context.

## Requirements

- **Node.js ≥ 20.11** (the server reads `import.meta.dirname`)
- **DeepSeek Harness** installed locally — `npm i -g @deepseek-ai/dsh`, or the DSH Desktop app,
  which keeps its CLI profiles under `~/.dsh`
- A **DeepSeek API key**. The CLI profile does *not* inherit the key stored by DSH Desktop; without
  `DEEPSEEK_API_KEY` in the environment DSH fails with `MISSING_CREDENTIAL`.

Verified on Windows 11. The code paths for Linux and macOS are there but have not been exercised —
reports welcome.

## Install

```bash
git clone <this repo> deepseek-bridge
cd deepseek-bridge
npm install
```

Register it with Claude Code:

```bash
claude mcp add deepseek-bridge --scope user \
  --env DEEPSEEK_API_KEY=sk-... \
  -- node /absolute/path/to/deepseek-bridge/index.mjs
```

Or add it to `~/.claude.json` by hand:

```json
{
  "mcpServers": {
    "deepseek-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/deepseek-bridge/index.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-...",
        "DEEPSEEK_BRIDGE_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Restart the client afterwards — MCP servers are started at session start.

## The tool

```text
deepseek_ask(prompt, cwd?, timeout_sec?, include_reasoning?)
```

- **prompt** — the whole task, self-contained. DSH does not see your conversation. Name files by
  path rather than pasting them. Hard limit **28 000 characters**: the headless profile takes the
  task as a positional argument and offers no `--prompt-file`, and Windows caps a command line at
  32 767.
- **cwd** — working directory, default `DEEPSEEK_BRIDGE_CWD` or the server's own. This matters more
  than it looks: `dsh-agent-instructions` loads `AGENTS.md` / `CLAUDE.md` / `RULES.md` by walking
  from the project root down to `cwd`, so a directory outside your project means an agent answering
  without your project's conventions.
- **timeout_sec** — default 600. On timeout the call **fails**; a truncated answer is never returned
  as if it were complete.
- **include_reasoning** — append DSH's stderr reasoning to the answer. Off by default.

One shot per call. The headless profile has no `--resume`, so there is no session to continue;
multi-turn work belongs to DSH's `tui` profile and is deliberately out of scope here.

## What it looks like in use

Ask the agent holding this tool to delegate something bulky. The point is to name paths, not paste
contents:

```js
deepseek_ask({
  prompt: "Read docs/architecture.md and CHANGELOG.md in this project. List every breaking " +
          "change introduced since v2.0, one per line, with the version it landed in. " +
          "If a change is only implied rather than stated, say so instead of guessing."
})
```

```text
v2.1 — config key `retries` renamed to `maxRetries`
v2.3 — plugin hooks now receive a frozen context object
v3.0 — Node 18 dropped

---
Took 11.2s in /home/me/project.
DSH produced 2143 chars of reasoning on stderr. Tool calls are NOT reported by the headless
profile — if the answer states a fact about this codebase, confirm it was read rather than recalled.
```

Both files were opened by DSH. Neither one's text ever entered the calling agent's context — that
is the whole economy of this bridge.

## When it does not work

**`DSH returned no answer (exit 1)` with `MISSING_CREDENTIAL`**
DSH found no API key. The key stored by DSH Desktop lives in its own credential store and is *not*
inherited by the CLI profile. Put `DEEPSEEK_API_KEY` in the server's `env` block and restart the
client.

**`DeepSeek Harness entry point not found`**
The error lists every path that was tried. If your install is elsewhere, set `DSH_BIN` to its
`lib/bin.js` — that wins over all detection.

**The server starts and nothing happens: exit 0, no output, no error**
Almost always the entry-point check. If you reach this file through a symlink or a junction, Node
resolves `import.meta.url` to the link target while `argv[1]` keeps the path as spawned, so a naive
comparison decides the file was imported rather than run, and `main()` is never called. This bridge
compares resolved real paths (case-insensitively on Windows) precisely to avoid that, so if you see
it after editing that part — that is where to look.

**`Prompt is N chars, over the 28000 limit`**
The headless profile takes the task through `argv` and has no `--prompt-file`. Name files by path
instead of pasting them; that is cheaper for you anyway.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | **Required.** Passed to the DSH child process. |
| `DEEPSEEK_BRIDGE_CWD` | `process.cwd()` | Default working directory for delegated tasks. |
| `DSH_BIN` | — | Absolute path to DSH's `lib/bin.js`. Wins over any auto-detection. |
| `DSH_HOME` | `~/.dsh` | Where DSH Desktop keeps its CLI profiles. |
| `DEEPSEEK_BRIDGE_LOG` | off | Set to `1` to enable the call log. |
| `DEEPSEEK_BRIDGE_LOG_DIR` | `./logs` | Where the log is written. |

If DSH cannot be located, the error lists every path that was tried — set `DSH_BIN` to whichever
one is right for your install.

## Logging is off by default

With `DEEPSEEK_BRIDGE_LOG=1` the server appends one JSON line per call to
`logs/YYYY-MM-DD.jsonl`, containing **the prompt and the answer verbatim**, truncated to 2 000 and
8 000 characters. That is genuinely useful for debugging and genuinely unwanted by default, since
those fields may hold whatever you were working on. It stays off unless you ask for it.

## What this bridge will not tell you

The headless profile does not report which tools DSH called, so — unlike a bridge that can list
them — this one cannot show you what the answer was based on. The footer says so on every reply.
Treat a factual claim about your codebase as verified only if the task made DSH read the file.

## Behaviour worth knowing

- A run killed by the timeout is reported as a failure, never as a partial success.
- The whole process tree is killed on timeout and when the server exits — DSH spawns children of
  its own, and on Windows there is no process group to signal, so `taskkill /T` does the work.
- A non-zero exit code alongside a real answer is surfaced in the footer rather than swallowed.

## License

MIT
