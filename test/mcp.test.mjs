// Covers the MCP surface the calling agent actually sees: the tool list, a real tools/call over
// stdio, and the input validation. Everything below goes through the protocol rather than calling
// exported functions, because that is the only way the schema and the response shape get exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "index.mjs");
const fixture = path.join(here, "..", "fixtures", "fake-dsh.mjs");

// Sends a batch of requests, collects the responses, and lets the server exit when stdin closes.
function talk(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        DSH_BIN: fixture,
        DEEPSEEK_API_KEY: "test-key-not-used-by-the-fixture",
        DEEPSEEK_BRIDGE_LOG: "0",
        ...extraEnv,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not answer in time; output so far: ${stdout}`));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);

      const messages = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      resolve(messages);
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }

    child.stdin.end();
  });
}

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

const answerTo = (messages, id) => messages.find((message) => message.id === id);

test("the server advertises exactly one tool, named deepseek_ask", async () => {
  const messages = await talk([...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const tools = answerTo(messages, 2).result.tools;

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["deepseek_ask"],
  );
  assert.match(tools[0].description, /DeepSeek Harness/);

  // The description is what the calling agent decides on, so it has to carry the warnings rather
  // than leave them to a README the agent never sees. Matching only the product name would let a
  // revision quietly go back to describing DSH as something that merely reads files.
  for (const [pattern, missing] of [
    [/NOT A READER/i, "that DSH can write and run commands"],
    [/inherits/i, "that the child inherits this server's environment"],
    [/cannot show|which tools/i, "that tool calls are not reported back"],
  ]) {
    assert.match(tools[0].description, pattern, `the tool description no longer states ${missing}`);
  }
});

test("its schema requires a prompt and accepts the documented options", async () => {
  const messages = await talk([...handshake, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }]);
  const schema = answerTo(messages, 2).result.tools[0].inputSchema;

  assert.deepEqual(schema.required, ["prompt"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["cwd", "include_reasoning", "prompt", "timeout_sec"]);
});

test("a tools/call returns the answer with the footer appended", async () => {
  const messages = await talk([
    ...handshake,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "deepseek_ask", arguments: { prompt: "say ok", cwd: here } },
    },
  ]);

  const text = answerTo(messages, 3).result.content[0].text;

  assert.match(text, /^ok/);
  assert.match(text, /Took \d+\.\d+s/);
  // The footer must keep saying the tool calls are unknown — that is the honesty guarantee.
  assert.match(text, /Tool calls are NOT reported/);
});

test("an over-long prompt is refused through the protocol, not swallowed", async () => {
  const messages = await talk([
    ...handshake,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "deepseek_ask", arguments: { prompt: "x".repeat(28_001), cwd: here } },
    },
  ]);

  const answer = answerTo(messages, 3);
  const text = JSON.stringify(answer);

  assert.match(text, /over the 28000 limit/);
});

test("a call missing the required prompt is rejected by the schema", async () => {
  const messages = await talk([
    ...handshake,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "deepseek_ask", arguments: {} } },
  ]);

  const answer = answerTo(messages, 3);

  assert.ok(answer, "the server must answer a malformed call rather than stay silent");
  assert.match(JSON.stringify(answer).toLowerCase(), /prompt|required|invalid/);
});

const callText = async (args, extraEnv = {}) => {
  const messages = await talk(
    [
      ...handshake,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "deepseek_ask", arguments: { prompt: "say ok", ...args } },
      },
    ],
    extraEnv,
  );

  const answer = answerTo(messages, 3);

  assert.ok(answer.result, `the call failed: ${JSON.stringify(answer)}`);

  return answer.result.content[0].text;
};

test("include_reasoning is off by default and appends stderr when asked", async () => {
  const quiet = await callText({ cwd: here });
  const verbose = await callText({ cwd: here, include_reasoning: true });

  // The fixture writes "thinking" to stderr; it must stay out of the answer unless requested.
  assert.ok(!quiet.includes("thinking"));
  assert.match(verbose, /reasoning \(stderr\)/);
  assert.match(verbose, /thinking/);
});

test("the working directory comes from cwd, and the footer names it", async () => {
  assert.ok((await callText({ cwd: here })).includes(here));
});

test("without cwd the server falls back to DEEPSEEK_BRIDGE_CWD", async () => {
  const text = await callText({}, { DEEPSEEK_BRIDGE_CWD: here });

  assert.ok(text.includes(here), `footer did not name the configured default: ${text}`);
});

test("a cwd that does not exist is refused with that path named", async () => {
  const messages = await talk([
    ...handshake,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "deepseek_ask", arguments: { prompt: "say ok", cwd: path.join(here, "no-such-dir") } },
    },
  ]);

  assert.match(JSON.stringify(answerTo(messages, 3)), /cwd does not exist/);
});
