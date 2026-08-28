import { test } from "node:test";
import assert from "node:assert/strict";
import { contributedSkillPaths } from "../src/skills.js";
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
