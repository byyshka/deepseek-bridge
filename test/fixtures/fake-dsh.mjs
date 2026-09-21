#!/usr/bin/env node
// Stands in for DeepSeek Harness so the bridge's failure paths can be exercised without the real
// CLI, a network call or an API key. The bridge spawns it through DSH_BIN, with the same arguments
// it would pass to the real thing: --profile headless "<task>".
//
// The task text selects the behaviour, so one fixture covers every case.

const task = process.argv.slice(2).find((argument) => !argument.startsWith("--") && argument !== "headless") ?? "";

if (task.includes("HANG")) {
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
