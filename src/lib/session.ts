// Extracted runtime; source attribution is recorded in the extraction-provenance fixture.
//
// Shared session-id resolution used by both agent-pi-harness-lifecycle.ts and
// agent-pi-harness-warden.ts's PreToolUse dispatch (PR 3535 review round 2 P1 finding C)
// so the synthesized dispatch.py payload carries the same session identity
// regardless of which extension built it.

import type { PiExtensionContext as ExtensionContext } from "../pi-types.js";
import { randomUUID } from "node:crypto";
import type { ProjectAdapterV1 } from "../project-adapter.js";

const fallbackSessionIds = new WeakMap<object, string>();

/** Resolves a stable session identifier: the launcher's adapter-configured
 * env var first (set for every Pi launch, matching the Python side's
 * ownership identity), falling back to the session runtime's own id when
 * the env var is unset (PR 3535 review round 1 P1 finding 1). */
export function resolveSessionId(
  ctx: ExtensionContext,
  adapter: ProjectAdapterV1,
): string {
  const fromEnv = process.env[adapter.sessionIdEnv];
  if (fromEnv) return fromEnv;
  try {
    const runtimeSessionId = ctx.sessionManager.getSessionId();
    if (runtimeSessionId) return runtimeSessionId;
  } catch {}
  const runtime = ctx as object;
  const existing = fallbackSessionIds.get(runtime);
  if (existing) return existing;
  const generated = `pi-runtime-${randomUUID()}`;
  fallbackSessionIds.set(runtime, generated);
  return generated;
}
