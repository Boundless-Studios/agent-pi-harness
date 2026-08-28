// Extracted runtime; source attribution is recorded in the extraction-provenance fixture.
//
// `resources_discover` handler: contributes each configured skill-root path
// for every entry in the compatibility manifest whose status is not
// "claude-only".

// ResourcesDiscoverEvent/ResourcesDiscoverResult are not re-exported at the
// package root (only ExtensionAPI's `on("resources_discover", ...)` overload
// carries them internally) — the handler below relies on contextual typing
// from that overload instead of naming the types directly.
import type { PiExtensionAPI as ExtensionAPI } from "./pi-types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveProjectPath,
  validateProjectAdapterV1,
} from "./project-adapter.js";
import type { ProjectAdapterV1 } from "./project-adapter.js";

export type SkillCompatStatus = "loads-clean" | "needs-shim" | "claude-only";

export interface SkillCompatEntry {
  readonly name: string;
  readonly status: SkillCompatStatus;
  readonly markers: readonly string[];
  readonly notes: string;
}

export interface SkillCompatManifest {
  readonly skills: readonly SkillCompatEntry[];
}

function isSkillCompatManifest(value: unknown): value is SkillCompatManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.skills) && candidate.skills.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      typeof record.name === "string" &&
      ["loads-clean", "needs-shim", "claude-only"].includes(String(record.status)) &&
      Array.isArray(record.markers) &&
      record.markers.every((marker) => typeof marker === "string") &&
      typeof record.notes === "string"
    );
  });
}

export function loadSkillCompatManifest(manifestPath: string): SkillCompatManifest {
  const raw = readFileSync(manifestPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isSkillCompatManifest(parsed)) {
    throw new Error(`${manifestPath} did not parse as a skill compatibility manifest`);
  }
  return parsed;
}

/** The configured skill-root paths this manifest contributes — every entry
 * whose status is not "claude-only". */
export function contributedSkillPaths(
  manifest: SkillCompatManifest,
  worktreeRoot: string,
  skillRoots: readonly string[],
): string[] {
  return manifest.skills
    .filter((entry) => entry.status !== "claude-only")
    .flatMap((entry) =>
      skillRoots.map((root) => join(resolveProjectPath(worktreeRoot, root), entry.name)),
    );
}

export function registerSkills(
  pi: ExtensionAPI,
  adapter: ProjectAdapterV1,
): void {
  const validatedAdapter = validateProjectAdapterV1(adapter);
  pi.on("resources_discover", (_event, ctx) => {
    const manifestPath = join(
      resolveProjectPath(ctx.cwd, validatedAdapter.projectPaths.configRoot),
      validatedAdapter.projectPaths.skillManifestFile,
    );
    try {
      const manifest = loadSkillCompatManifest(manifestPath);
      return { skillPaths: contributedSkillPaths(manifest, ctx.cwd, validatedAdapter.skillRoots) };
    } catch {
      return {};
    }
  });

  pi.on("session_start", () => {
    // A durable, greppable marker lets project smoke checks prove this
    // extension actually loaded and ran.
    pi.appendEntry("agent-pi-harness-smoke", { extension: "agent-pi-harness-skills" });
  });
}

/** Inert unless a project shim supplies an explicit adapter. */
export default function skills(pi: ExtensionAPI, adapter?: ProjectAdapterV1): void {
  if (adapter === undefined) return;
  registerSkills(pi, adapter);
}
