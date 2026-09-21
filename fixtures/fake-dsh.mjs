#!/usr/bin/env node
// Stands in for DeepSeek Harness so the bridge's failure paths can be exercised without the real
// CLI, a network call or an API key. The bridge spawns it through DSH_BIN, with the same arguments
// it would pass to the real thing: --profile headless "<task>".
//
// The task text selects the behaviour, so one fixture covers every case.
//
// It is deliberately strict about the arguments it receives. A lenient stand-in answers "ok" no
// matter how it was invoked, which would keep every test green even if the bridge stopped passing
// --profile headless, or stopped passing the task at all.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const fail = (reason) => {
  process.stderr.write(`fake-dsh: ${reason}\ngot: ${JSON.stringify(argv)}\n`);
  process.exit(64);
};

const profileAt = argv.indexOf("--profile");

if (profileAt === -1 || argv[profileAt + 1] !== "headless") {
  fail("expected `--profile headless`");
}

// The task is the positional argument, i.e. everything that is not the profile flag or its value.
const positional = argv.filter((argument, index) => index !== profileAt && index !== profileAt + 1);

if (positional.length !== 1) {
  fail(`expected exactly one positional task argument, got ${positional.length}`);
}

const task = positional[0];

if (task.includes("SPAWNCHILD")) {
  // Start a detached grandchild that deliberately outlives this process, the way DSH's own
  // children do. Killing only the wrapper leaves it running; taskkill /T takes the whole tree.
  // Its pid goes to a file, because a timed-out call returns no output to read it from.
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  grandchild.unref();

  if (process.env.FIXTURE_PID_FILE) {
    writeFileSync(process.env.FIXTURE_PID_FILE, String(grandchild.pid), "utf8");
  }

  setTimeout(() => {}, 60_000);
} else if (task.includes("HANG")) {
  // Outlive any timeout the test sets; the bridge is expected to kill this process.
  setTimeout(() => {}, 60_000);
} else if (task.includes("EMPTY")) {
  // Exit cleanly having said nothing — the "no answer" path.
  process.exit(0);
} else if (task.includes("FAIL")) {
  process.stderr.write('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"\n');
  process.exit(1);
} else if (task.includes("SLOWANSWER")) {
  // Produce output, then hang: a timeout must not report this partial text as a clean result.
  process.stdout.write("partial text\n");
  setTimeout(() => {}, 60_000);
} else if (task.includes("DIRTYEXIT")) {
  // A real answer alongside a non-zero exit code, as kimi-code does on Windows.
  process.stdout.write("answer despite exit 1\n");
  process.exit(1);
} else {
  process.stderr.write("dsh: reasoning:\nthinking\n");
  process.stdout.write("ok\n");
  process.exit(0);
}
