import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPython } from "../src/run-python.js";

test("runPython contains stdin EPIPE when Python exits before reading", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-run-python-"));
  try {
    const result = await runPython(
      "missing-script.py",
      [],
      { payload: "x".repeat(2_000_000) },
      cwd,
    );
    assert.notEqual(result.code, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
