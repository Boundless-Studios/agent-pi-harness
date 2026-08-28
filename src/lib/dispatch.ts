// Extracted runtime; source attribution is recorded in the extraction-provenance fixture.
//
// Shared project-dispatch invocation, result shape, and advisory-surfacing
// helpers used by both lifecycle and Warden registration.

import { runPython } from "../run-python.js";
import type { RunPythonEnvironment } from "../run-python.js";
import {
  DEFAULT_PROJECT_ADAPTER_V1,
  resolveProjectArgv,
} from "../project-adapter.js";
import type { ProjectAdapterV1 } from "../project-adapter.js";

export interface DispatchResult {
  readonly results: readonly unknown[];
  readonly block: boolean;
  readonly block_reason: string;
  readonly torn_down: readonly string[];
  readonly teardown_warnings: readonly string[];
}

export function isDispatchResult(value: unknown): value is DispatchResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.results) &&
    typeof candidate.block === "boolean" &&
    typeof candidate.block_reason === "string" &&
    Array.isArray(candidate.torn_down) &&
    Array.isArray(candidate.teardown_warnings)
  );
}

/** A dispatch.py invocation that failed at the EXTENSION BOUNDARY (missing
 * script, nonzero exit, unparseable/malformed stdout) rather than inside a
 * hook. `teardown_warnings` is otherwise only ever populated by dispatch.py
 * itself on SessionStart/SessionEnd, so a non-empty entry here on any other
 * event is a reliable, shape-preserving signal that this synthetic result —
 * not a real dispatch.py output — was returned (consumed by agent-pi-harness-warden.ts's
 * PreToolUse bounded-release counter, PR 3535 review round 2 P1 finding C). */
export function emptyDispatchResult(teardownWarning?: string): DispatchResult {
  return {
    results: [],
    block: false,
    block_reason: "",
    torn_down: [],
    teardown_warnings: teardownWarning ? [teardownWarning] : [],
  };
}

export type RunDispatch = (
  event: string,
  cwd: string,
  payload: Record<string, unknown>,
  adapter: ProjectAdapterV1,
) => Promise<DispatchResult>;

/** Total characters of surfaced advisory text before truncation (bound per PR
 * 3535 review round 1 P1 finding 2 — advisories must never flood the UI). */
export const ADVISORY_MAX_LENGTH = 4000;

export function boundLength(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/** Concatenates non-empty stdout/stderr from every advisory (non-blocking)
 * dispatch result entry, prefixed by the originating hook's path, so a
 * successful advisory hook (e.g. the budget-guard's checkpoint JSON on
 * stdout with exit 0) is still visible instead of silently dropped (PR 3535
 * review round 1 P1 finding 2). Returns "" when there is nothing to show. */
export function collectAdvisoryText(result: DispatchResult): string {
  const parts: string[] = [...result.teardown_warnings];
  for (const entry of result.results) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const hook = typeof record.hook === "string" ? record.hook : "unknown-hook";
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    if (stdout) parts.push(`[${hook}] ${stdout}`);
    if (stderr) parts.push(`[${hook}] ${stderr}`);
  }
  return parts.join("\n");
}

/** When `payload.context_window` is a positive finite number, forwards it as
 * the adapter's budget-context env var — the one env var
 * the response-budget policy's environment setup
 * itself reads and maps onto the underlying harness's explicit window
 * override (PR 3535 review round 2 P1 finding D). The guard consumes NO
 * `context_window` payload KEY directly — only this env var, or its `model`
 * payload key for coarse family-substring matching — so this is the only
 * channel that can deliver the configured model's exact context window instead of
 * the family match's 128,000 or the hook's own 200,000 default. */
export function budgetGuardEnvOverride(
  payload: Record<string, unknown>,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): RunPythonEnvironment | undefined {
  const window = payload.context_window;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  const variable = adapter.budgetContextEnv;
  return variable ? { ...process.env, [variable]: String(Math.trunc(window)) } : process.env;
}

/** The real dispatch.py caller — the default `runDispatch` used by both
 * extensions' `pi.on(...)` wiring. */
export async function runDispatch(
  event: string,
  cwd: string,
  payload: Record<string, unknown>,
  adapter: ProjectAdapterV1,
): Promise<DispatchResult> {
  const command = adapter.policyArgv.dispatch;
  const result = await runPython(
    command.script,
    resolveProjectArgv(command.argv, { cwd, event }),
    payload,
    cwd,
    budgetGuardEnvOverride(payload, adapter),
    adapter.timeouts.policyMs,
  );

  if (result.code !== 0) {
    return emptyDispatchResult(`${command.script} exited ${result.code}: ${result.stderr.trim()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return emptyDispatchResult(`${command.script} produced unparseable stdout: ${result.stdout.trim()}`);
  }

  if (!isDispatchResult(parsed)) {
    return emptyDispatchResult(`${command.script} produced an unexpected payload shape`);
  }
  return parsed;
}
