import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixtures/gaia-pre-extraction/runtime-hashes.json" with { type: "json" };

const projectRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

test("runtime modules are present and match the pre-extraction fixture", async () => {
  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const module of fixture.modules) {
    const path = resolve(projectRoot, module.target);
    try {
      await access(path);
    } catch {
      missing.push(module.target);
      continue;
    }

    const contents = await readFile(path);
    const digest = createHash("sha256").update(contents).digest("hex");
    if (digest !== module.sha256) {
      mismatched.push(`${module.target} (expected ${module.sha256}, got ${digest})`);
    }
  }

  assert.deepEqual({ missing, mismatched }, { missing: [], mismatched: [] });
});
