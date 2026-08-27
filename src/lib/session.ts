// Pi harness parity PR 2 (docs/plans/evaluate-harness-shift.md Step 4).
//
// Shared session-id resolution used by both gaia-lifecycle.ts and
// gaia-warden.ts's PreToolUse dispatch (PR 3535 review round 2 P1 finding C)
// so the synthesized dispatch.py payload carries the same session identity
// regardless of which extension built it.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Resolves a stable session identifier: the launcher's `GAIA_SESSION_ID`
 * env var first (set for every Pi launch, matching the Python side's
 * ownership identity), falling back to the session runtime's own id when
 * the env var is unset (PR 3535 review round 1 P1 finding 1). */
export function resolveSessionId(ctx: ExtensionContext): string {
  const fromEnv = process.env.GAIA_SESSION_ID;
  if (fromEnv) return fromEnv;
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}
