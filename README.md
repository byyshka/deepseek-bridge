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
- **A working DeepSeek Harness install** — see the next section, this is the part that takes time
- A **DeepSeek API key** available to the bridge as `DEEPSEEK_API_KEY`

**Windows only.** Built and tested on Windows 11. There are POSIX branches in the code, but they are
neither tested nor supported.

## Set up DeepSeek Harness first

This bridge is a thin adapter. It spawns DSH and reads its output; it does not install, configure or
authenticate anything. **DSH is a separate product with its own setup, and that setup is not a
five-minute job** — budget an evening for it rather than a coffee break.

What has to be in place before the bridge is of any use:

1. **DSH itself** — [DeepSeek Harness][dsh], either `npm i -g @deepseek-ai/dsh` or the DSH Desktop
   application, which keeps its CLI profiles under `$DSH_HOME` (`~/.dsh` by default). Both work;
   the bridge probes the known layouts and `DSH_BIN` overrides all of them.

   [dsh]: https://github.com/deepseek-ai/deepseek-harness

2. **Credentials.** If you installed through Desktop, note that it stores the key in its own
   credential service and **the CLI profile does not inherit it** — running headless then fails with
   `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`. Either
   store the key through DSH's own Models page, or pass `DEEPSEEK_API_KEY` in the bridge's
   environment, which is what the config example below does.

3. **The `headless` profile.** The bridge runs `dsh --profile headless`, which answers one task and
   exits. Confirm it works on its own before wiring anything up:

   ```bash
   dsh --profile headless "reply with one word: ok"
   ```

   If your profile stack does not include it, create one from a shipped template — `web` is the
   one that ships by default:

   ```powershell
   dsh --profile headless --from-default-profile web
   ```

   Profiles are a DSH concept; its own documentation is the authority on which templates exist.

4. **Project instructions, if you want them respected.** DSH loads `AGENTS.md`, `CLAUDE.md` and
   `RULES.md` by walking from the project root down to the working directory. Whatever conventions
   you expect the delegated agent to follow have to exist in those files — the bridge only decides
   *which directory* it runs in, through `cwd` / `DEEPSEEK_BRIDGE_CWD`. Note that DSH does **not**
   read `.claude/rules/`, so rules kept only there will not reach it.

5. **Optionally, MCP servers for DSH** — see the next section. Anything you give DSH there, the
   delegated agent can use; none of it comes from this bridge.

Only once `dsh --profile headless "..."` answers correctly on its own does it make sense to install
the bridge. Nearly every "the bridge does not work" case is really a DSH setup that was never
finished.

## What you are handing over

Worth being blunt about, because the framing "it reads files for you" undersells it.

**DSH is a full agent, not a reader.** It has its own tools — it can write files and run commands,
and what it is allowed to do is governed by DSH's own permission settings, not by this bridge. This
bridge chooses *which directory* it starts in and passes your instruction; everything after that is
between you and DSH. Read DSH's own safety documentation before pointing it anywhere that matters.

**The child process inherits this server's environment.** No variable filtering happens here, so
whatever your MCP client put in the server's environment — including credentials meant for other
tools — is visible to the delegated agent. Keep the server's `env` block to what DSH actually
needs.

**`cwd` is the blast radius.** It decides both which files the agent can reach and which project
instructions it picks up. Passing a directory outside your project gives you an agent working
without your conventions, in a place you did not intend.

## Where this pays off most: 1C:Enterprise (BSL)

Nothing here is domain-specific, but the combination lands hardest in 1C work, for two reasons
that compound.

**Modules are large and questions about them are cheap to ask, expensive to read.** A 70 KB common
module, an XML form definition, a configuration dump — pulling one into the calling agent's context
to ask a single question costs more than the answer is worth. Here the path is named, not pasted,
and the file's text never enters the conversation.

**Names have to be checked, not recalled.** Attribute and register names drift between
configuration versions, so a model answering from training data produces something plausible and
wrong — and indistinguishable from a verified answer. Give DSH metadata servers of its own (see the
next section) and the delegated agent resolves `Справочник.Контрагенты.ИНН` against the real
configuration instead. Measured on this setup: twelve MCP servers, 99 tools, ready in about six
seconds, a metadata lookup answered in under twenty.

The bridge itself stays neutral — it spawns DSH and reads its output. Whether the delegated agent
knows anything about 1C is decided entirely by what you give it on the DSH side.

## Giving the delegated agent MCP tools

Worth knowing, because it is not obvious and the obvious route does not work: the agent behind this
bridge can have MCP servers of its own, but **it will not inherit the ones your DSH desktop app
uses**, and it will not read your `.mcp.json` either — that is a Claude Code file, DSH ignores it.

Two things get in the way:

- **Two different `DSH_HOME`s.** The desktop app runs with its own home (on Windows,
  `%APPDATA%\dsh-desktop\harness`), where agent presets with all your servers live. A `dsh` started
  from a terminal — which is what this bridge does — uses `~/.dsh`, where those presets do not
  exist.
- **The `headless` profile does not mount the preset machinery at all.** Presets come from the web
  app bundle, which `headless` does not include. So even pointing `DSH_HOME` at the desktop home
  does not help; here it failed outright with
  `NO_ADAPTER: no adapter registered for provider "claude-code-oauth"`, because the desktop settings
  declare subagents on providers this profile never loads.

What does work is declaring the servers in the headless profile's own patch layer,
`$DSH_HOME/profiles/headless/cordis.patch.yml`:

```yaml
- insert:
  - id: mcp-group
    name: cordis:group
    group: true
    config:
    - id: mcp-example-http
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: example_http
        transport: streamable-http
        url: http://localhost:8008/mcp

    - id: mcp-example-stdio
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: example_stdio
        transport: stdio
        command: uvx
        args: ['some-mcp-package@1.0.0']
```

Nothing to install: `@deepseek-ai/dsh-mcp-client` already ships with DSH. Tools then arrive as
`mcp__<serverName>__<tool>`. Measured here: twelve servers, 99 tools, ready in about six seconds.

Two cautions:

- **Do not copy an existing preset wholesale.** Presets routinely hold API tokens in plain text;
  copying one duplicates your secrets into a second file. Declare the servers you want by hand.
- **A dead server is silent.** With no `failOnStartupError`, a server that fails to start simply
  contributes no tools. An empty answer therefore means "check whether the server is up", not
  "the thing you asked about does not exist".

## Install

```powershell
git clone https://github.com/byyshka/deepseek-bridge.git
cd deepseek-bridge
npm install
npm test          # optional: runs offline, needs neither DSH nor an API key
```

Register it with Claude Code (the `claude` CLI has to be installed already):

```powershell
claude mcp add deepseek-bridge --scope user `
  --env DEEPSEEK_API_KEY=sk-... `
  -- node C:\path\to\deepseek-bridge\index.mjs
```

Or add it to `~/.claude.json` by hand — note the doubled backslashes, JSON needs them:

```json
{
  "mcpServers": {
    "deepseek-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\deepseek-bridge\\index.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-...",
        "DEEPSEEK_BRIDGE_CWD": "C:\\path\\to\\your\\project"
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
Took 11.2s in C:\path\to\your\project.
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
| `DEEPSEEK_BRIDGE_LOG_DIR` | `logs/` next to `index.mjs` | Where the log is written. Not relative to the working directory. |

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
