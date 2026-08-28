// Pi harness parity PR 2 (docs/plans/evaluate-harness-shift.md Step 4).
//
// Shared session-id resolution used by both agent-pi-harness-lifecycle.ts and
// agent-pi-harness-warden.ts's PreToolUse dispatch (PR 3535 review round 2 P1 finding C)
// so the synthesized dispatch.py payload carries the same session identity
// regardless of which extension built it.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PROJECT_ADAPTER_V1,
} from "../project-adapter.js";
import type { ProjectAdapterV1 } from "../project-adapter.js";

/** Resolves a stable session identifier: the launcher's adapter-configured
 * env var first (set for every Pi launch, matching the Python side's
 * ownership identity), falling back to the session runtime's own id when
 * the env var is unset (PR 3535 review round 1 P1 finding 1). */
export function resolveSessionId(
  ctx: ExtensionContext,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const fromEnv = process.env[adapter.sessionIdEnv];
  if (fromEnv) return fromEnv;
  try {
    return ctx.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}
