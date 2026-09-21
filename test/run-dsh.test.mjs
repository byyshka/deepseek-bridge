// Exercises the paths that matter most and cannot be checked by reading the code: what happens on
// a timeout, on an empty answer, and on a failure. The real CLI is replaced through DSH_BIN by a
// fixture, so these run offline, without an API key and in about a second.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDsh } from "../index.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-dsh.mjs");
const saved = {};

before(() => {
  saved.bin = process.env.DSH_BIN;
  saved.key = process.env.DEEPSEEK_API_KEY;
  process.env.DSH_BIN = fixture;
  process.env.DEEPSEEK_API_KEY = "test-key-not-used-by-the-fixture";
});

after(() => {
  if (saved.bin === undefined) {
    delete process.env.DSH_BIN;
  } else {
    process.env.DSH_BIN = saved.bin;
  }

  if (saved.key === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = saved.key;
  }
});

const call = (prompt, timeoutSec = 30) => runDsh({ prompt, cwd: process.cwd(), timeoutSec });

test("a normal run returns the answer and keeps stderr as reasoning", async () => {
  const result = await call("say ok");

  assert.equal(result.answer, "ok");
  assert.match(result.reasoning, /thinking/);
  assert.equal(result.exitCode, 0);
});

test("a timeout rejects instead of returning what had been produced", async () => {
  await assert.rejects(
    () => call("SLOWANSWER", 1),
    (error) => {
      assert.match(error.message, /killed by the 1s timeout/);
      // The partial text must be described as incomplete, never handed back as the answer.
      assert.match(error.message, /Partial output \(\d+ chars\)/);
      assert.ok(!/^partial text$/m.test(error.message));

      return true;
    },
  );
});

test("a timeout with no output says so plainly", async () => {
  await assert.rejects(() => call("HANG", 1), /No answer had been produced/);
});

test("an empty answer rejects rather than passing an empty string on", async () => {
  await assert.rejects(() => call("EMPTY"), /returned no answer \(exit 0\)/);
});

test("a failure surfaces the diagnosis line from stderr", async () => {
  await assert.rejects(() => call("FAIL"), /MISSING_CREDENTIAL/);
});

test("an answer arriving with a non-zero exit is kept, and the exit code is reported", async () => {
  const result = await call("DIRTYEXIT");

  assert.equal(result.answer, "answer despite exit 1");
  assert.equal(result.exitCode, 1);
});

test("a missing API key is refused before anything is spawned", async () => {
  const key = process.env.DEEPSEEK_API_KEY;

  delete process.env.DEEPSEEK_API_KEY;

  try {
    await assert.rejects(() => call("say ok"), /DEEPSEEK_API_KEY is not set/);
  } finally {
    process.env.DEEPSEEK_API_KEY = key;
  }
});

test("a working directory that does not exist is refused", async () => {
  await assert.rejects(
    () => runDsh({ prompt: "say ok", cwd: "/no/such/directory/anywhere", timeoutSec: 5 }),
    /cwd does not exist/,
  );
});
