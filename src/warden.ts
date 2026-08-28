// Extracted runtime; source attribution is recorded in the extraction-provenance fixture.
//
// Warden-equivalent pre-command gate: intercepts the built-in `bash` tool,
// calls the configured gate, and then forwards every approved command to the
// configured PreToolUse dispatcher. Matcher ownership stays entirely in the
// project dispatcher; this package never guesses which project rules apply.
//
// FAILS CLOSED (blocks) on a non-zero gate.py exit or unparseable/malformed
// stdout — a crashed or misbehaving gate must never silently allow, UNLESS
// the failure is itself the recurring symptom of a broken extension
// boundary (python3 unlaunchable, gate.py missing, its stdout unusable, OR
// the PreToolUse dispatch.py invocation failing the same way): after
// EXTENSION_FAILURE_RELEASE_THRESHOLD consecutive such failures this
// releases (allows) rather than wedging every later Bash call forever. A real
// policy block from a healthy gate or dispatcher never releases.

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type {
  PiExtensionAPI as ExtensionAPI,
  PiExtensionContext as ExtensionContext,
} from "./pi-types.js";
type SessionStartEvent = Record<string, never>;
import { runPython } from "./run-python.js";
import type { RunPythonResult } from "./run-python.js";
import { ADVISORY_MAX_LENGTH, boundLength, collectAdvisoryText, runDispatch } from "./lib/dispatch.js";
import type { DispatchResult, RunDispatch } from "./lib/dispatch.js";
import { resolveSessionId } from "./lib/session.js";
import {
  resolveProjectArgv,
  validateProjectAdapterV1,
} from "./project-adapter.js";
import type { ProjectAdapterV1 } from "./project-adapter.js";
import type { RunPythonEnvironment } from "./run-python.js";

export interface GateDecision {
  readonly decision: "allow" | "block";
  readonly reason: string;
  readonly rule: string;
}

export function isGateDecision(value: unknown): value is GateDecision {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.decision === "allow" || candidate.decision === "block") &&
    typeof candidate.reason === "string" &&
    typeof candidate.rule === "string"
  );
}

export interface ToolCallBlockResult {
  readonly block: true;
  readonly reason: string;
}

export type RunPythonFn = (
  scriptRelPath: string,
  argv: readonly string[],
  stdinJson: unknown,
  cwd: string,
  env?: RunPythonEnvironment,
  timeoutMs?: number,
) => Promise<RunPythonResult>;

export const EXTENSION_FAILURE_RELEASE_THRESHOLD = 3;

export interface WardenHandlerDeps {
  readonly runPythonImpl: RunPythonFn;
  readonly runDispatchImpl: RunDispatch;
  readonly sendMessage: (content: string) => void | Promise<void>;
  readonly adapter: ProjectAdapterV1;
}

export interface WardenHandlers {
  readonly handleBashToolCall: (
    command: string,
    cwd: string,
    sessionId?: string,
  ) => Promise<ToolCallBlockResult | undefined>;
  readonly onSessionStart: () => void;
  /** Consecutive gate.py extension-boundary failures (launch/exit/parse/shape) —
   * tracked independently of `dispatchFailureCount` (PR 3541 review, third
   * round): a healthy gate.py call resets ONLY this streak. */
  readonly gateFailureCount: () => number;
  /** Consecutive PreToolUse dispatcher invocation failures — tracked
   * independently of `gateFailureCount`: a healthy dispatcher call resets
   * only this streak. */
  readonly dispatchFailureCount: () => number;
}

/** A `PreToolUse` dispatch result is a synthetic EXTENSION-BOUNDARY failure
 * exactly when it carries a `teardown_warnings` entry — dispatch.py itself
 * never populates that field for `PreToolUse` (only SessionStart/SessionEnd
 * do), so a non-empty entry here can only be `lib/dispatch.ts`'s
 * `emptyDispatchResult(...)` synthesized diagnostic. */
function isDispatchInvocationFailure(result: DispatchResult): boolean {
  return result.teardown_warnings.length > 0;
}

/**
 * Builds the agent-pi-harness-warden `tool_call` handler over an injectable `deps`, with
 * its own consecutive-extension-failure counter — decoupled from
 * `pi.on(...)` wiring so it can be exercised directly against a stubbed
 * `runPythonImpl`/`runDispatchImpl` (bead AC: a runnable behavioral test).
 */
export function createWardenHandlers(deps: WardenHandlerDeps): WardenHandlers {
  const adapter = validateProjectAdapterV1(deps.adapter);
  const gateCommand = adapter.policyArgv.gate;
  const gateLabel = gateCommand.script.split("/").at(-1) ?? gateCommand.script;
  // gate.py and PreToolUse dispatch.py are independent extension
  // boundaries; each streak resets and releases only on ITS OWN health,
  // never the other's — a shared counter would mask failures on one
  // boundary with the other's.
  let gateFailures = 0;
  let dispatchFailures = 0;
  const fallbackSessionId = `pi-warden-${randomUUID()}`;

  function releaseOrBlock(
    source: "gate" | "dispatch",
    reason: string,
  ): ToolCallBlockResult | undefined {
    const count = source === "gate" ? (gateFailures += 1) : (dispatchFailures += 1);
    if (count < EXTENSION_FAILURE_RELEASE_THRESHOLD) {
      return { block: true, reason };
    }
    void deps.sendMessage(
      `${source}.py unavailable — released after ${count} consecutive ${source} failures; ` +
        `fix the extension boundary. Original error: ${reason}`,
    );
    return undefined;
  }

  /** Runs once gate.py has ALLOWED: the remaining PreToolUse fan-out
   * (PR 3535 review round 2 P1 finding C). A dispatch-invocation failure
   * increments ONLY `dispatchFailures`; a well-formed dispatch result —
   * block or clean — resets ONLY `dispatchFailures`, since it proves the
   * dispatch.py boundary itself worked end-to-end (independent of gate.py's
   * own health). */
  async function handlePreToolUseDispatch(
    command: string,
    cwd: string,
    sessionId: string,
  ): Promise<ToolCallBlockResult | undefined> {
    const result = await deps.runDispatchImpl("PreToolUse", cwd, {
      cwd,
      tool_name: "Bash",
      tool_input: { command },
      session_id: sessionId,
    }, adapter);

    if (isDispatchInvocationFailure(result)) {
      return releaseOrBlock(
        "dispatch",
        `${adapter.policyArgv.dispatch.script} PreToolUse failed: ${result.teardown_warnings.join("; ")}`,
      );
    }
    dispatchFailures = 0;

    if (result.block) {
      return { block: true, reason: result.block_reason };
    }
    const advisory = collectAdvisoryText(result);
    if (advisory) {
      void deps.sendMessage(boundLength(advisory, ADVISORY_MAX_LENGTH));
    }
    return undefined;
  }

  async function handleBashToolCall(
    command: string,
    cwd: string,
    sessionId = fallbackSessionId,
  ): Promise<ToolCallBlockResult | undefined> {
    let result: RunPythonResult;
    try {
      result = await deps.runPythonImpl(
        gateCommand.script,
        resolveProjectArgv(gateCommand.argv, { cwd }),
        { command, cwd },
        cwd,
        undefined,
        adapter.timeouts.policyMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return releaseOrBlock("gate", `${gateLabel} failed to launch: ${message}`);
    }

    if (result.code !== 0) {
      return releaseOrBlock("gate", `${gateLabel} exited ${result.code}: ${result.stderr.trim()}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return releaseOrBlock(
        "gate",
        `${gateLabel} produced unparseable stdout: ${result.stdout.trim()}`,
      );
    }

    if (!isGateDecision(parsed)) {
      return releaseOrBlock(
        "gate",
        `${gateLabel} produced an unexpected payload shape: ${result.stdout.trim()}`,
      );
    }

    // gate.py produced a well-formed decision — the gate.py extension
    // boundary is healthy regardless of the decision it made or what
    // happens next (a real block, an allow that skips dispatch, or an allow
    // that proceeds to dispatch). Reset ONLY the gate streak; dispatch.py's
    // own streak is untouched here — it can only be resolved by an actual
    // dispatch.py round trip.
    gateFailures = 0;

    if (parsed.decision === "block") {
      // A real policy block from a healthy gate.py. This never releases.
      return { block: true, reason: parsed.reason };
    }
    if (parsed.rule === "gate-error-released") {
      // gate.py itself already bounded-released after ITS OWN internal
      // fan-out failures and is warning us in-band via an "allow" decision —
      // previously discarded by this generic allow path, silently hiding
      // that the safety gate had been bypassed (PR 3535 review round 2 P2
      // finding E).
      void deps.sendMessage(`${gateLabel} released with a warning: ${parsed.reason}`);
    }
    return handlePreToolUseDispatch(command, cwd, sessionId);
  }

  return {
    handleBashToolCall,
    onSessionStart: () => {
      gateFailures = 0;
      dispatchFailures = 0;
    },
    gateFailureCount: () => gateFailures,
    dispatchFailureCount: () => dispatchFailures,
  };
}

export function registerWarden(
  pi: ExtensionAPI,
  adapter: ProjectAdapterV1,
): void {
  const validatedAdapter = validateProjectAdapterV1(adapter);
  let projectCwd = process.cwd();
  const handlers = createWardenHandlers({
    runPythonImpl: runPython,
    runDispatchImpl: runDispatch,
    adapter: validatedAdapter,
    sendMessage: (content) =>
      pi.sendMessage({ customType: "agent-pi-harness-warden", content, display: true }),
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    projectCwd = ctx.cwd;
    handlers.onSessionStart();
    // A durable, greppable marker lets project smoke checks prove this
    // extension actually loaded and ran.
    pi.appendEntry("agent-pi-harness-smoke", { extension: "agent-pi-harness-warden" });
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    return handlers.handleBashToolCall(
      event.input.command,
      projectCwd,
      resolveSessionId(ctx, validatedAdapter),
    );
  });
}

/** Inert unless a project shim supplies an explicit adapter. */
export default function warden(pi: ExtensionAPI, adapter?: ProjectAdapterV1): void {
  if (adapter === undefined) return;
  registerWarden(pi, adapter);
}
