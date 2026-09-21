// Guards the entry-point check — the one failure that actually happened: reached through a
// junction, the server exited 0 and started nothing, with no error anywhere.
//
// It can only be tested by launching the real process, since the decision depends on how the file
// was spawned, so each case here starts a server and reads its banner off stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "index.mjs");

// Starting with stdin closed makes the server print its banner and exit, so no process is left behind.
function bannerOf(entryPath) {
  const result = spawnSync(process.execPath, [entryPath], {
    input: "",
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });

  return `${result.stderr}${result.stdout}`;
}

test("started by its own path, the server announces itself", () => {
  assert.match(bannerOf(server), /deepseek-bridge \d+\.\d+\.\d+ on stdio/);
});

test("a path differing only in case still starts the server", { skip: process.platform !== "win32" }, () => {
  // Windows paths are case-insensitive, but realpathSync returns the case it was given: comparing
  // the two strictly would decide this file was imported rather than run.
  //
  // Only the directories are shouted — Node matches the file EXTENSION case-sensitively and would
  // refuse ".MJS" outright, which would test the loader rather than this predicate.
  const shouted = path.join(path.dirname(server).toUpperCase(), path.basename(server));

  assert.match(bannerOf(shouted), /deepseek-bridge \d+\.\d+\.\d+ on stdio/);
});

test("reached through a junction, the server still starts", { skip: process.platform !== "win32" }, (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "bridge-junction-"));
  const link = path.join(temp, "linked");

  try {
    execFileSync("cmd", ["/c", "mklink", "/J", link, path.join(here, "..")], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    rmSync(temp, { recursive: true, force: true });
    t.skip("could not create a junction in the temp directory");

    return;
  }

  try {
    // Node resolves import.meta.url to the junction target while argv[1] keeps this path; a naive
    // URL comparison is false here and the server would silently do nothing.
    assert.match(bannerOf(path.join(link, "index.mjs")), /deepseek-bridge \d+\.\d+\.\d+ on stdio/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("imported as a module, the server does not start", async () => {
  // Importing the module must not bring up a stdio server; the suites that import it would hang.
  const probe = [
    `await import(${JSON.stringify(new URL("../index.mjs", import.meta.url).href)});`,
    "console.log('imported without starting');",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });

  assert.match(result.stdout, /imported without starting/);
  assert.ok(!/on stdio/.test(result.stderr), `server started on import: ${result.stderr}`);
});
