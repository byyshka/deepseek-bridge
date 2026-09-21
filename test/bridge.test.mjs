import { test } from "node:test";
import assert from "node:assert/strict";

import { extractFailureHint, formatResult, resolveDshEntry } from "../index.mjs";

test("extractFailureHint picks the diagnosis line out of DSH stderr", () => {
  const stderr = [
    "dsh: reasoning:",
    "thinking about the task",
    'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"',
  ].join("\n");

  assert.match(extractFailureHint(stderr), /^dsh: MISSING_CREDENTIAL:/);
});

test("extractFailureHint returns null when stderr holds only reasoning", () => {
  assert.equal(extractFailureHint("dsh: reasoning:\njust thinking"), null);
});

test("formatResult states plainly that tool calls are unknown", () => {
  const text = formatResult(
    { answer: "42", reasoning: "some reasoning", exitCode: 0, durationMs: 1500, cwd: "/tmp" },
    false,
  );

  assert.match(text, /^42/);
  assert.match(text, /Tool calls are NOT reported/);
});

test("formatResult flags an answer that came with a non-zero exit", () => {
  const text = formatResult(
    { answer: "42", reasoning: "", exitCode: 1, durationMs: 1000, cwd: "/tmp" },
    false,
  );

  assert.match(text, /Exit code was 1/);
});

test("formatResult appends reasoning only when asked", () => {
  const result = { answer: "42", reasoning: "chain of thought", exitCode: 0, durationMs: 10, cwd: "/tmp" };

  assert.ok(!formatResult(result, false).includes("chain of thought"));
  assert.match(formatResult(result, true), /chain of thought/);
});

test("DSH_BIN pointing at a missing file fails with that path named", () => {
  const previous = process.env.DSH_BIN;

  process.env.DSH_BIN = "/definitely/not/here/bin.js";

  try {
    assert.throws(() => resolveDshEntry(), /DSH_BIN points at a missing file/);
  } finally {
    if (previous === undefined) {
      delete process.env.DSH_BIN;
    } else {
      process.env.DSH_BIN = previous;
    }
  }
});

test("a missing DSH install reports every path that was tried", () => {
  const previousBin = process.env.DSH_BIN;
  const previousHome = process.env.DSH_HOME;

  delete process.env.DSH_BIN;
  process.env.DSH_HOME = "/nonexistent-dsh-home";

  try {
    assert.throws(() => resolveDshEntry(), (error) => {
      assert.match(error.message, /entry point not found/);
      assert.match(error.message, /nonexistent-dsh-home/);
      assert.match(error.message, /npm i -g @deepseek-ai\/dsh/);

      return true;
    });
  } finally {
    if (previousBin !== undefined) {
      process.env.DSH_BIN = previousBin;
    }

    if (previousHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previousHome;
    }
  }
});
