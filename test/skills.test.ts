import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skills, { contributedSkillPaths, loadSkillCompatManifest } from "../src/skills.js";
import type { SkillCompatManifest } from "../src/skills.js";
import { GAIA_FIXTURE_ADAPTER } from "./fixtures/gaia-adapter.js";

test("agent-pi-harness-skills: contributes .claude/skills/<name> for every non-claude-only entry", () => {
  const manifest: SkillCompatManifest = {
    skills: [
      { name: "codex", status: "loads-clean", markers: [], notes: "" },
      {
        name: "gaia-test-runner",
        status: "needs-shim",
        markers: ["TodoWrite"],
        notes: "uses TodoWrite",
      },
      {
        name: "agent-context-usage",
        status: "claude-only",
        markers: ["claude "],
        notes: "Claude-only rotation store",
      },
    ],
  };

  const paths = contributedSkillPaths(manifest, "/worktree", GAIA_FIXTURE_ADAPTER.skillRoots);

  assert.deepEqual(paths, [
    "/worktree/.claude/skills/codex",
    "/worktree/.claude/skills/gaia-test-runner",
  ]);
});
test("agent-pi-harness-skills: an empty manifest contributes no paths", () => {
  assert.deepEqual(
    contributedSkillPaths({ skills: [] }, "/worktree", GAIA_FIXTURE_ADAPTER.skillRoots),
    [],
  );
});

test("agent-pi-harness-skills: every manifest entry is validated", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-skills-"));
  const manifest = join(cwd, "skills.json");
  try {
    writeFileSync(
      manifest,
      JSON.stringify({
        skills: [
          { name: "valid", status: "loads-clean", markers: [], notes: "ok" },
          { name: 42, status: "unknown", markers: [null], notes: false },
        ],
      }),
    );
    assert.throws(() => loadSkillCompatManifest(manifest), /compatibility manifest/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("skills registration requires an explicit project adapter", () => {
  let registrations = 0;
  assert.doesNotThrow(() =>
    skills({ on: () => { registrations += 1; } } as any),
  );
  assert.equal(registrations, 0);
});
