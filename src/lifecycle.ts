// Extracted runtime; source attribution is recorded in the extraction-provenance fixture.
//
// Lifecycle dispatcher shim: forwards Pi lifecycle events to the configured
// dispatch policy command per the event-mapping table.
//   tool_result       -> PostToolUse (advisory, surfaced via sendMessage)
//   agent_settled     -> Stop (re-engage via sendUserMessage, capped;
//                         a dispatch-invocation FAILURE is itself treated
//                         as blocking, with its own bounded release)
//   input             -> UserPromptSubmit (advisory, surfaced via sendMessage)
//   session_start     -> SessionStart (stale-owner sweep runs inside dispatch.py)
//   session_shutdown  -> SessionEnd (teardown-by-owner runs inside dispatch.py;
//                         this handler AWAITS it before returning)
// `tool_call` is handled by agent-pi-harness-warden.ts, not here. PreCompact has no Pi
// event; response-budget-guard.py's --reset already runs on SessionStart
// per the manifest (unmapped, by design).

import type {
  PiAgentEndEvent as AgentEndEvent,
  PiExtensionAPI as ExtensionAPI,
  PiExtensionContext as ExtensionContext,
  PiInputEvent as InputEvent,
  PiMessageStartEvent as MessageStartEvent,
  PiSessionShutdownEvent as SessionShutdownEvent,
  PiToolResultEvent as ToolResultEvent,
} from "./pi-types.js";
type SessionStartEvent = Record<string, never>;
type AgentSettledEvent = Record<string, never>;
type AgentStartEvent = Record<string, never>;
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ADVISORY_MAX_LENGTH,
  boundLength,
  collectAdvisoryText,
  runDispatch,
} from "./lib/dispatch.js";
import type { DispatchResult, RunDispatch } from "./lib/dispatch.js";
import { resolveModelContext } from "./lib/model-context.js";
import type { ModelContext } from "./lib/model-context.js";
import { resolveSessionId } from "./lib/session.js";
import {
  DEFAULT_PROJECT_ADAPTER_V1,
  resolveProjectArgv,
  resolveProjectPath,
  validateProjectAdapterV1,
} from "./project-adapter.js";
import type { ProjectAdapterV1 } from "./project-adapter.js";

export type { DispatchResult, RunDispatch };
export { ADVISORY_MAX_LENGTH };

export function buildOperatorStatus(worktreePath: string, prUrl?: string, prState?: string): string {
  const worktree = `file://${worktreePath}`;
  return prUrl
    ? `worktree: ${worktree}  PR: ${prUrl}${prState ? ` (${prState})` : ""}`
    : `worktree: ${worktree}`;
}

export type PiTabColor = "blue" | "yellow" | "green" | "red";
export type PiTabState = "ready" | "working" | "done" | "needs_input";
export type AgentSettledOutcome =
  | "completed"
  | "reengaged"
  | "blocked"
  | "dispatch_failed"
  | "agent_failed";

export function tabColorForState(state: PiTabState): PiTabColor {
  switch (state) {
    case "ready":
      return "blue";
    case "working":
      return "yellow";
    case "done":
      return "green";
    case "needs_input":
      return "red";
  }
}

export function tabColorAfterAgentSettled(outcome: AgentSettledOutcome): PiTabColor {
  switch (outcome) {
    case "completed":
      return tabColorForState("done");
    case "reengaged":
      // sendUserMessage can report success before Pi emits agent_start; keep
      // the settled run blocked until that event proves work actually began.
      return tabColorForState("needs_input");
    case "blocked":
    case "dispatch_failed":
    case "agent_failed":
      return tabColorForState("needs_input");
  }
}

export function tabColorForPendingReplay(hasPendingBlock: boolean): PiTabColor {
  return tabColorForState(hasPendingBlock ? "needs_input" : "ready");
}

export function tabColorForAgentStart(dispatchFailurePending: boolean): PiTabColor {
  return tabColorForState(dispatchFailurePending ? "needs_input" : "working");
}

export function agentRunNeedsAttention(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as { role?: unknown; stopReason?: unknown };
    if (candidate?.role !== "assistant") continue;
    return (
      candidate.stopReason === "error" ||
      candidate.stopReason === "aborted" ||
      candidate.stopReason === "length"
    );
  }
  return false;
}

async function setTabColor(
  pi: ExtensionAPI,
  cwd: string,
  color: PiTabColor,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): Promise<void> {
  const command = adapter.lifecycleIntentArgv.tabColor;
  await pi.exec(command[0], [...command.slice(1), color], {
    cwd,
    timeout: adapter.timeouts.tabColorMs,
  });
}

async function refreshOperatorStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): Promise<void> {
  const command = adapter.lifecycleIntentArgv.operatorStatus;
  let prUrl = "";
  let prState = "";
  try {
    const pr = await pi.exec(command[0], [...command.slice(1)], {
      cwd,
      timeout: adapter.timeouts.operatorStatusMs,
    });
    if (pr.code === 0 && pr.stdout.trim()) {
      const data = JSON.parse(pr.stdout) as {
        url?: string;
        reviewDecision?: string;
        statusCheckRollup?: Array<{ status?: string; conclusion?: string }>;
      };
      prUrl = data.url ?? "";
      const checks = data.statusCheckRollup ?? [];
      const ci = checks.some((check) => check.conclusion && !["SUCCESS", "SKIPPED"].includes(check.conclusion))
        ? "CI failing"
        : checks.some((check) => check.status !== "COMPLETED") ? "CI pending" : "CI green";
      prState = data.reviewDecision ? `${ci}, ${data.reviewDecision.toLowerCase()}` : ci;
    }
  } catch {
    // Operator-status rendering is advisory. Policy dispatch and session
    // startup must continue when its command is unavailable or malformed.
  }
  ctx.ui.setStatus(
    "harness-links",
    ctx.ui.theme.fg("accent", buildOperatorStatus(cwd, prUrl || undefined, prState || undefined)),
  );
}

async function safePiAsyncCall(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    if (!isStaleRuntimeError(error)) throw error;
    console.error(`[agent-pi-harness-lifecycle] ${label} skipped — extension runtime went stale`);
    return false;
  }
}

export function shouldRefreshOperatorStatus(event: ToolResultEvent): boolean {
  if (event.toolName.toLowerCase() !== "bash") return false;
  const command = typeof event.input.command === "string" ? event.input.command : "";
  return /\b(?:git\s+push|gh\s+pr\s+(?:create|ready))\b/.test(command);
}

/** Extract the last assistant-authored text without depending on a provider's
 * richer message shape. This is persisted and shown on a real Pi quit so the
 * operator always has a human-readable final handoff. */
export function finalAssistantSummary(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const item = part as { type?: unknown; text?: unknown };
          return item?.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return "Pi session ended without an assistant-authored summary.";
}

/** Return the exact text of a user message, ignoring non-text attachments. */
export function userMessageText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") return undefined;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .map((part) => {
      const item = part as { type?: unknown; text?: unknown };
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
  return text || undefined;
}

/**
 * Substring of the exact message Pi's runtime throws from a captured
 * `pi: ExtensionAPI` (or `ExtensionContext`) once the underlying session has
 * been replaced or reloaded — `ctx.newSession()`, `ctx.fork()`,
 * `ctx.switchSession()`, `ctx.reload()`, OR another extension entirely
 * triggering the same runtime replacement. Confirmed live (drive-run
 * finding, BOU-3084/PR 3541): a plain `pi -p --approve "..."` run in this
 * repo hits this from agent-pi-harness-lifecycle on every invocation, root-caused to
 * pi-subagents' periodic background-work snapshot replacing the runtime
 * mid-session — nothing agent-pi-harness-lifecycle itself calls. Pi's own guidance
 * ("move post-replacement work into withSession") only applies to code that
 * ITSELF calls one of those methods; agent-pi-harness-lifecycle never does, so there is
 * no `withSession` callback to hook into, and the replacement is entirely
 * out-of-band from this extension's point of view.
 */
const STALE_RUNTIME_ERROR_MARKER = "ctx is stale after session replacement or reload";

export function isStaleRuntimeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_RUNTIME_ERROR_MARKER);
}

/**
 * Wraps a captured `pi.sendMessage`/`pi.sendUserMessage`/`pi.appendEntry`
 * call so a stale-runtime throw degrades to a stderr log instead of an
 * uncaught "Extension error". These calls always happen in an async
 * continuation AFTER an `await deps.runDispatch(...)` — the exact window in
 * which the runtime can be replaced out from under this extension (see
 * `isStaleRuntimeError` above) — so every one of them needs this guard, not
 * just the teardown-warning path the drive-run finding reproduced. Any OTHER
 * error is rethrown: this must never mask a real bug in the call itself.
 */
export function safePiCall(label: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (!isStaleRuntimeError(error)) throw error;
    console.error(`[agent-pi-harness-lifecycle] ${label} skipped — extension runtime went stale`);
    return false;
  }
}

export interface PendingCompletionBlock {
  readonly schema_version: 2;
  readonly kind: "completion-block";
  readonly dispatch_id: string;
  readonly session_id: string;
  readonly message: string;
  readonly owner_pid?: number;
  readonly owner_process_start?: string;
  readonly branch_name?: string;
  readonly delivery_runtime_id?: string;
  /** Monotonic identity of the Stop invocation that produced this block. */
  readonly stop_order?: number;
  /** Source budget retained while an orphan claim is being finalized. */
  readonly budget_source_session_id?: string;
  /** Original budget source when a staged claim is published before transfer. */
  readonly budget_transfer_source_session_id?: string;
}

export interface PendingBlockRecoveryHooks {
  readonly beforeBudgetCleanup?: () => void;
  readonly afterBudgetTransfer?: () => void;
}

function pendingBlockPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const sessionIdentity = createHash("sha256").update(sessionId).digest("hex");
  return join(
    resolveProjectPath(cwd, adapter.projectPaths.stateRoot),
    `pending-block-${sessionIdentity}.json`,
  );
}

export interface ActiveTurnState {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly runtime_id: string;
  readonly turn_id: string;
  readonly started_at: number;
  /** PID that created the marker; used to reject dead launcher state. */
  readonly owner_pid: number;
  readonly owner_process_start?: string;
}

function activeTurnPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const sessionIdentity = createHash("sha256").update(sessionId).digest("hex");
  return join(
    resolveProjectPath(cwd, adapter.projectPaths.stateRoot),
    `active-turn-${sessionIdentity}.json`,
  );
}

export function readActiveTurn(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): ActiveTurnState | undefined {
  if (!sessionId) return undefined;
  try {
    return parseActiveTurnRecord(
      JSON.parse(readFileSync(activeTurnPath(cwd, sessionId, adapter), "utf8")),
      sessionId,
    );
  } catch {
    return undefined;
  }
}

function parseActiveTurnRecord(value: unknown, sessionId: string): ActiveTurnState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== 1 ||
    record.session_id !== sessionId ||
    typeof record.runtime_id !== "string" ||
    !record.runtime_id ||
    typeof record.turn_id !== "string" ||
    !record.turn_id ||
    typeof record.started_at !== "number" ||
    !Number.isFinite(record.started_at) ||
    typeof record.owner_pid !== "number" ||
    !Number.isInteger(record.owner_pid) ||
    record.owner_pid <= 1 ||
    !isProcessAlive(
      record.owner_pid,
      typeof record.owner_process_start === "string" ? record.owner_process_start : undefined,
    )
  ) {
    return undefined;
  }
  if (
    record.owner_process_start !== undefined &&
    typeof record.owner_process_start !== "string"
  ) {
    return undefined;
  }
  return {
    schema_version: 1,
    session_id: sessionId,
    runtime_id: record.runtime_id,
    turn_id: record.turn_id,
    started_at: record.started_at,
    owner_pid: record.owner_pid,
    ...(typeof record.owner_process_start === "string"
      ? { owner_process_start: record.owner_process_start }
      : {}),
  };
}

export function persistActiveTurn(
  cwd: string,
  sessionId: string,
  runtimeId: string,
  turnId: string,
  startedAt = Date.now(),
  ownerPid = process.pid,
  ownerProcessStart = processIncarnation(ownerPid),
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sessionId || !runtimeId || !turnId) return;
  const path = activeTurnPath(cwd, sessionId, adapter);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    temporary,
    `${JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      runtime_id: runtimeId,
      turn_id: turnId,
      started_at: startedAt,
      owner_pid: ownerPid,
      ...(ownerProcessStart ? { owner_process_start: ownerProcessStart } : {}),
    })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, path);
}

/**
 * Clear an active-turn marker only when the caller still owns the exact
 * runtime/turn it started. The claim rename keeps a replacement runtime's
 * marker from being deleted by a late agent_end callback.
 */
export function clearActiveTurn(
  cwd: string,
  sessionId: string,
  runtimeId: string,
  turnId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): boolean {
  const path = activeTurnPath(cwd, sessionId, adapter);
  const current = readActiveTurn(cwd, sessionId, adapter);
  if (
    !current ||
    current.runtime_id !== runtimeId ||
    current.turn_id !== turnId
  ) {
    return false;
  }
  const claimedPath = `${path}.ending-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, claimedPath);
  } catch {
    return false;
  }
  const claimed = readActiveTurnAtPath(claimedPath, sessionId);
  if (
    !claimed ||
    claimed.runtime_id !== runtimeId ||
    claimed.turn_id !== turnId
  ) {
    try {
      linkSync(claimedPath, path);
      rmSync(claimedPath, { force: true });
    } catch {
      if (existsSync(path)) rmSync(claimedPath, { force: true });
    }
    return false;
  }
  rmSync(claimedPath, { force: true });
  return true;
}

function readActiveTurnAtPath(path: string, sessionId: string): ActiveTurnState | undefined {
  try {
    return parseActiveTurnRecord(JSON.parse(readFileSync(path, "utf8")), sessionId);
  } catch {
    return undefined;
  }
}

export interface LifecycleBudget {
  readonly schema_version: 1;
  readonly session_id: string;
  /** Branch that owns this launch budget; prevents reuse after repointing. */
  readonly branch_name?: string;
  readonly reengage_count: number;
  readonly stop_dispatch_failure_count: number;
  /** Monotonic Stop order that most recently incremented the failure count. */
  readonly latest_stop_dispatch_failure_order?: number;
  /** Source sessions already folded into this budget, for replay idempotency. */
  readonly transferred_from_session_ids?: readonly string[];
}

interface LifecycleBudgetMutation {
  readonly reengageDelta?: number;
  readonly stopDispatchFailureDelta?: number;
  readonly stopDispatchFailureOrder?: number;
  readonly resetStopDispatchFailure?: boolean;
  /** Manual input starts a new failure sequence but must retain ordering. */
  readonly preserveStopDispatchFailureOrder?: boolean;
  readonly reengageLimit?: number;
}

interface LifecycleBudgetUpdate {
  readonly budget: LifecycleBudget;
  readonly reengageIncremented: boolean;
}

function currentBranchName(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) return branch;
    const head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return head ? `detached:${head}` : undefined;
  } catch {
    return undefined;
  }
}

function isPendingBlockForCurrentBranch(
  cwd: string,
  pending: PendingCompletionBlock,
  branchName: string | undefined | null = null,
): boolean {
  const currentBranch = branchName === null ? currentBranchName(cwd) : branchName;
  return currentBranch
    ? pending.branch_name === currentBranch
    : pending.branch_name === undefined;
}

function lifecycleBudgetPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const sessionIdentity = createHash("sha256").update(sessionId).digest("hex");
  return join(
    resolveProjectPath(cwd, adapter.projectPaths.stateRoot),
    `lifecycle-budget-${sessionIdentity}.json`,
  );
}

export function readLifecycleBudget(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): LifecycleBudget | undefined {
  if (!sessionId) return undefined;
  try {
    const record = JSON.parse(readFileSync(lifecycleBudgetPath(cwd, sessionId, adapter), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      record.schema_version !== 1 ||
      record.session_id !== sessionId ||
      typeof record.reengage_count !== "number" ||
      !Number.isInteger(record.reengage_count) ||
      record.reengage_count < 0 ||
      typeof record.stop_dispatch_failure_count !== "number" ||
      !Number.isInteger(record.stop_dispatch_failure_count) ||
      record.stop_dispatch_failure_count < 0
    ) {
      return undefined;
    }
    const branchName = currentBranchName(cwd);
    if (
      record.branch_name !== undefined &&
      typeof record.branch_name !== "string"
    ) {
      return undefined;
    }
    if (branchName ? record.branch_name !== branchName : record.branch_name !== undefined) {
      return undefined;
    }
    const transferredFromSessionIds = record.transferred_from_session_ids;
    if (
      transferredFromSessionIds !== undefined &&
      (!Array.isArray(transferredFromSessionIds) ||
        !transferredFromSessionIds.every(
          (session) => typeof session === "string" && session.length > 0,
        ))
    ) {
      return undefined;
    }
    const latestFailureOrder = record.latest_stop_dispatch_failure_order;
    if (
      latestFailureOrder !== undefined &&
      (typeof latestFailureOrder !== "number" ||
        !Number.isSafeInteger(latestFailureOrder) ||
        latestFailureOrder < 0)
    ) {
      return undefined;
    }
    return {
      schema_version: 1,
      session_id: sessionId,
      ...(typeof record.branch_name === "string" ? { branch_name: record.branch_name } : {}),
      reengage_count: record.reengage_count,
      stop_dispatch_failure_count: record.stop_dispatch_failure_count,
      ...(latestFailureOrder !== undefined
        ? { latest_stop_dispatch_failure_order: latestFailureOrder }
        : {}),
      ...(transferredFromSessionIds && transferredFromSessionIds.length > 0
        ? { transferred_from_session_ids: transferredFromSessionIds }
        : {}),
    };
  } catch {
    return undefined;
  }
}

const LIFECYCLE_BUDGET_LOCK_RETRY_MS = 5;
const LIFECYCLE_BUDGET_LOCK_ATTEMPTS = 200;
const LIFECYCLE_BUDGET_LOCK_STALE_MS = 60_000;

function sleepSynchronously(milliseconds: number): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

interface LifecycleBudgetLockSnapshot {
  readonly raw: string;
  readonly stale: boolean;
}

function readLifecycleBudgetLock(path: string): LifecycleBudgetLockSnapshot | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const lock = JSON.parse(raw) as Record<string, unknown>;
    if (typeof lock.owner_pid === "number" && Number.isInteger(lock.owner_pid)) {
      const ownerStart = typeof lock.owner_process_start === "string"
        ? lock.owner_process_start
        : undefined;
      return { raw, stale: !isProcessAlive(lock.owner_pid, ownerStart) };
    }
    return {
      raw,
      stale: Date.now() - statSync(path).mtimeMs >= LIFECYCLE_BUDGET_LOCK_STALE_MS,
    };
  } catch {
    try {
      const raw = readFileSync(path, "utf8");
      return {
        raw,
        stale: Date.now() - statSync(path).mtimeMs >= LIFECYCLE_BUDGET_LOCK_STALE_MS,
      };
    } catch {
      return undefined;
    }
  }
}

function reclaimStaleLifecycleBudgetLock(
  path: string,
  observed: LifecycleBudgetLockSnapshot,
): boolean {
  const reclaimPath = `${path}.reclaim`;
  try {
    writeFileSync(
      reclaimPath,
      `${JSON.stringify({
        observed_lock: observed.raw,
        owner_pid: process.pid,
        owner_process_start: processIncarnation(process.pid),
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    try {
      const marker = JSON.parse(readFileSync(reclaimPath, "utf8")) as Record<string, unknown>;
      if (
        typeof marker.owner_pid === "number" &&
        !isProcessAlive(
          marker.owner_pid,
          typeof marker.owner_process_start === "string"
            ? marker.owner_process_start
            : undefined,
        )
      ) {
        // A crashed claimant can leave a marker for an older lock contents.
        // Its dead-owner marker is safe to remove even when this observer saw
        // a newer stale lock, otherwise that old marker would block reclaim
        // forever because the marker path is shared by all lock identities.
        rmSync(reclaimPath, { force: true });
      }
    } catch {
      try {
        if (Date.now() - statSync(reclaimPath).mtimeMs >= LIFECYCLE_BUDGET_LOCK_STALE_MS) {
          rmSync(reclaimPath, { force: true });
        }
      } catch {
        // Another claimant may have removed the marker concurrently.
      }
    }
    return false;
  }
  try {
    const current = readLifecycleBudgetLock(path);
    if (!current || current.raw !== observed.raw || !current.stale) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    try {
      const marker = JSON.parse(readFileSync(reclaimPath, "utf8")) as Record<string, unknown>;
      if (
        marker.observed_lock === observed.raw &&
        marker.owner_pid === process.pid
      ) {
        rmSync(reclaimPath, { force: true });
      }
    } catch {
      // The reclaim marker is only a coordination aid; a later stale marker
      // cleanup can safely leave it in place if this process is interrupted.
    }
  }
}

function withLifecycleBudgetLock<T>(
  path: string,
  action: () => T,
): T | undefined {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < LIFECYCLE_BUDGET_LOCK_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          lock_token: randomUUID(),
          owner_pid: process.pid,
          owner_process_start: processIncarnation(process.pid),
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const observed = readLifecycleBudgetLock(lockPath);
      if (observed?.stale && reclaimStaleLifecycleBudgetLock(lockPath, observed)) {
        continue;
      }
      sleepSynchronously(LIFECYCLE_BUDGET_LOCK_RETRY_MS);
    }
  }
  if (!acquired) return undefined;
  try {
    return action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

interface StopOrderState {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly next_order: number;
  readonly latest_healthy_order?: number;
}

function stopOrderPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const sessionIdentity = createHash("sha256").update(sessionId).digest("hex");
  return join(
    resolveProjectPath(cwd, adapter.projectPaths.stateRoot),
    `stop-order-${sessionIdentity}.json`,
  );
}

function stopOrderFallbackPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  return `${stopOrderPath(cwd, sessionId, adapter)}.fallback`;
}

function readStopOrderStateAtPath(path: string, sessionId: string): StopOrderState | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      record.schema_version !== 1 ||
      record.session_id !== sessionId ||
      typeof record.next_order !== "number" ||
      !Number.isSafeInteger(record.next_order) ||
      record.next_order < 0
    ) {
      return undefined;
    }
    const latestHealthyOrder = record.latest_healthy_order;
    if (
      latestHealthyOrder !== undefined &&
      (typeof latestHealthyOrder !== "number" ||
        !Number.isSafeInteger(latestHealthyOrder) ||
        latestHealthyOrder < 0)
    ) {
      return undefined;
    }
    return {
      schema_version: 1,
      session_id: sessionId,
      next_order: record.next_order,
      ...(latestHealthyOrder !== undefined
        ? { latest_healthy_order: latestHealthyOrder }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function readStopOrderState(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): StopOrderState | undefined {
  if (!sessionId) return undefined;
  const primary = readStopOrderStateAtPath(stopOrderPath(cwd, sessionId, adapter), sessionId);
  const fallback = readStopOrderStateAtPath(stopOrderFallbackPath(cwd, sessionId, adapter), sessionId);
  if (!primary) return fallback;
  if (!fallback) return primary;
  const healthyOrders = [primary.latest_healthy_order, fallback.latest_healthy_order].filter(
    (order): order is number => order !== undefined,
  );
  return {
    schema_version: 1,
    session_id: sessionId,
    next_order: Math.max(primary.next_order, fallback.next_order),
    ...(healthyOrders.length > 0
      ? { latest_healthy_order: Math.max(...healthyOrders) }
      : {}),
  };
}

function writeStopOrderState(path: string, state: StopOrderState): void {
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function allocateStopOrder(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): number | undefined {
  if (!sessionId) return Date.now();
  const path = stopOrderPath(cwd, sessionId, adapter);
  const allocated = withLifecycleBudgetLock(path, () => {
    const current = readStopOrderState(cwd, sessionId, adapter) ?? {
      schema_version: 1 as const,
      session_id: sessionId,
      next_order: 0,
    };
    const nextOrder = current.next_order + 1;
    writeStopOrderState(path, {
      ...current,
      next_order: nextOrder,
    });
    return nextOrder;
  });
  if (allocated !== undefined) return allocated;

  // A live lock can outlast the one-second allocation window during a Stop
  // dispatch failure. Keep the fallback comparable with later allocations by
  // publishing its timestamp as the durable high-water mark. This is a
  // best-effort recovery write: if the filesystem also fails, return no order
  // rather than creating a pending block whose ordering identity cannot be
  // resumed by a later Stop.
  const fallback = Date.now();
  try {
    const current = readStopOrderState(cwd, sessionId, adapter);
    const fallbackState = {
      ...(current ?? {
        schema_version: 1 as const,
        session_id: sessionId,
        next_order: 0,
      }),
      next_order: Math.max(current?.next_order ?? 0, fallback),
    };
    // Keep the fallback in a sidecar until a later lock holder has
    // incorporated the high-water mark. This caller does not own the primary
    // lock, so writing the primary file here could overwrite a newer state
    // published by the lock holder between our read and this write.
    writeStopOrderState(stopOrderFallbackPath(cwd, sessionId, adapter), fallbackState);
    return fallback;
  } catch {
    return undefined;
  }
}

function recordHealthyStopOrder(
  cwd: string,
  sessionId: string,
  stopOrder: number,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): boolean {
  // A session-less Stop uses an in-memory timestamp and has no durable state
  // to update. Preserve that legacy path; named sessions must record the
  // healthy high-water mark before their completion can be reported.
  if (!sessionId) return true;
  if (!Number.isSafeInteger(stopOrder) || stopOrder < 0) return false;
  const path = stopOrderPath(cwd, sessionId, adapter);
  const recorded = withLifecycleBudgetLock(path, () => {
    const current = readStopOrderState(cwd, sessionId, adapter) ?? {
      schema_version: 1 as const,
      session_id: sessionId,
      next_order: stopOrder,
    };
    writeStopOrderState(path, {
      ...current,
      next_order: Math.max(current.next_order, stopOrder),
      latest_healthy_order: Math.max(current.latest_healthy_order ?? 0, stopOrder),
    });
    return true;
  });
  if (recorded === true) return true;

  // A live lock can outlast the bounded lock window. Publish the healthy
  // high-water mark to the merged sidecar so a later lock holder can retain
  // it; completion is still considered durable only if this fallback write
  // succeeds.
  try {
    const current = readStopOrderState(cwd, sessionId, adapter);
    const fallbackState = {
      ...(current ?? {
        schema_version: 1 as const,
        session_id: sessionId,
        next_order: stopOrder,
      }),
      next_order: Math.max(current?.next_order ?? 0, stopOrder),
      latest_healthy_order: Math.max(current?.latest_healthy_order ?? 0, stopOrder),
    };
    writeStopOrderState(stopOrderFallbackPath(cwd, sessionId, adapter), fallbackState);
    return true;
  } catch {
    return false;
  }
}

function latestHealthyStopOrder(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): number | undefined {
  return readStopOrderState(cwd, sessionId, adapter)?.latest_healthy_order;
}

function transferStopOrderState(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  inheritedStopOrder?: number,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): boolean {
  if (!sourceSessionId || sourceSessionId === targetSessionId) return true;
  const source = readStopOrderState(cwd, sourceSessionId, adapter);
  if (!source && inheritedStopOrder === undefined) return true;
  const targetPath = stopOrderPath(cwd, targetSessionId, adapter);
  const transferred = withLifecycleBudgetLock(targetPath, () => {
    const current = readStopOrderState(cwd, targetSessionId, adapter);
    const nextOrder = Math.max(
      current?.next_order ?? 0,
      source?.next_order ?? 0,
      inheritedStopOrder ?? 0,
    );
    const latestHealthyOrder = Math.max(
      current?.latest_healthy_order ?? 0,
      source?.latest_healthy_order ?? 0,
    );
    writeStopOrderState(targetPath, {
      schema_version: 1,
      session_id: targetSessionId,
      next_order: nextOrder,
      latest_healthy_order: latestHealthyOrder,
    });
    return true;
  });
  return transferred === true;
}

function cleanupTransferredStopOrderState(
  cwd: string,
  sourceSessionId: string | undefined,
  targetSessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sourceSessionId || sourceSessionId === targetSessionId) return;
  if (!readStopOrderState(cwd, targetSessionId, adapter)) return;
  rmSync(stopOrderPath(cwd, sourceSessionId, adapter), { force: true });
  rmSync(stopOrderFallbackPath(cwd, sourceSessionId, adapter), { force: true });
}

function cleanupCompletedLifecycleState(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sessionId || existsSync(pendingBlockPath(cwd, sessionId, adapter))) return;
  rmSync(stopOrderPath(cwd, sessionId, adapter), { force: true });
  rmSync(stopOrderFallbackPath(cwd, sessionId, adapter), { force: true });
  rmSync(lifecycleBudgetPath(cwd, sessionId, adapter), { force: true });
  rmSync(pendingBlockDeliveryQueuePath(cwd, sessionId, adapter), { force: true });
}

function writeLifecycleBudget(
  path: string,
  sessionId: string,
  reengageCount: number,
  stopDispatchFailureCount: number,
  latestStopDispatchFailureOrder?: number,
  transferredFromSessionIds: readonly string[] = [],
  branchName?: string,
): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      ...(branchName !== undefined ? { branch_name: branchName } : {}),
      reengage_count: reengageCount,
      stop_dispatch_failure_count: stopDispatchFailureCount,
      ...(latestStopDispatchFailureOrder !== undefined
        ? { latest_stop_dispatch_failure_order: latestStopDispatchFailureOrder }
        : {}),
      ...(transferredFromSessionIds.length > 0
        ? { transferred_from_session_ids: transferredFromSessionIds }
        : {}),
    })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, path);
}

export function persistLifecycleBudget(
  cwd: string,
  sessionId: string,
  reengageCount: number,
  stopDispatchFailureCount: number,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sessionId) return;
  const path = lifecycleBudgetPath(cwd, sessionId, adapter);
  withLifecycleBudgetLock(path, () => {
    writeLifecycleBudget(
      path,
      sessionId,
      reengageCount,
      stopDispatchFailureCount,
      undefined,
      [],
      currentBranchName(cwd),
    );
  });
}

function updateLifecycleBudget(
  cwd: string,
  sessionId: string,
  mutation: LifecycleBudgetMutation,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): LifecycleBudgetUpdate | undefined {
  if (!sessionId) return undefined;
  const path = lifecycleBudgetPath(cwd, sessionId, adapter);
  const branchName = currentBranchName(cwd);
  return withLifecycleBudgetLock(path, () => {
    const current = readLifecycleBudget(cwd, sessionId, adapter) ?? {
      schema_version: 1 as const,
      session_id: sessionId,
      ...(branchName !== undefined ? { branch_name: branchName } : {}),
      reengage_count: 0,
      stop_dispatch_failure_count: 0,
    };
    const requestedReengageDelta = mutation.reengageDelta ?? 0;
    const reengageIncremented = requestedReengageDelta > 0 &&
      (mutation.reengageLimit === undefined ||
        current.reengage_count < mutation.reengageLimit);
    const reengageCount = reengageIncremented
      ? current.reengage_count + requestedReengageDelta
      : current.reengage_count;
    const stopDispatchFailureCount = mutation.resetStopDispatchFailure
      ? 0
      : current.stop_dispatch_failure_count + (mutation.stopDispatchFailureDelta ?? 0);
    const latestStopDispatchFailureOrder = mutation.resetStopDispatchFailure
      ? mutation.preserveStopDispatchFailureOrder
        ? current.latest_stop_dispatch_failure_order
        : undefined
      : current.latest_stop_dispatch_failure_order !== undefined ||
          mutation.stopDispatchFailureOrder !== undefined
        ? Math.max(
            current.latest_stop_dispatch_failure_order ?? 0,
            mutation.stopDispatchFailureOrder ?? 0,
          )
        : undefined;
    const budget = {
      schema_version: 1 as const,
      session_id: sessionId,
      ...(branchName !== undefined ? { branch_name: branchName } : {}),
      reengage_count: reengageCount,
      stop_dispatch_failure_count: stopDispatchFailureCount,
      ...(latestStopDispatchFailureOrder !== undefined
        ? { latest_stop_dispatch_failure_order: latestStopDispatchFailureOrder }
        : {}),
      ...(current.transferred_from_session_ids
        ? { transferred_from_session_ids: current.transferred_from_session_ids }
        : {}),
    };
    writeLifecycleBudget(
      path,
      sessionId,
      budget.reengage_count,
      budget.stop_dispatch_failure_count,
      budget.latest_stop_dispatch_failure_order,
      budget.transferred_from_session_ids ?? [],
      branchName,
    );
    return { budget, reengageIncremented };
  });
}

function transferLifecycleBudget(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): boolean {
  if (!sourceSessionId || sourceSessionId === targetSessionId) return true;
  const branchName = currentBranchName(cwd);
  const source = readLifecycleBudget(cwd, sourceSessionId, adapter);
  if (!source) return true;
  const targetPath = lifecycleBudgetPath(cwd, targetSessionId, adapter);
  const transferred = withLifecycleBudgetLock(targetPath, () => {
    const current = readLifecycleBudget(cwd, targetSessionId, adapter) ?? {
      schema_version: 1 as const,
      session_id: targetSessionId,
      ...(branchName !== undefined ? { branch_name: branchName } : {}),
      reengage_count: 0,
      stop_dispatch_failure_count: 0,
    };
    if (current.transferred_from_session_ids?.includes(sourceSessionId)) return true;
    const transferredFromSessionIds = [
      ...(current.transferred_from_session_ids ?? []),
      sourceSessionId,
    ];
    const failureOrders = [
      current.latest_stop_dispatch_failure_order,
      source.latest_stop_dispatch_failure_order,
    ].filter((order): order is number => order !== undefined);
    writeLifecycleBudget(
      targetPath,
      targetSessionId,
      current.reengage_count + source.reengage_count,
      current.stop_dispatch_failure_count + source.stop_dispatch_failure_count,
      failureOrders.length > 0 ? Math.max(...failureOrders) : undefined,
      transferredFromSessionIds,
      branchName,
    );
    return true;
  });
  return transferred === true;
}

function cleanupTransferredLifecycleBudget(
  cwd: string,
  sourceSessionId: string | undefined,
  targetSessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sourceSessionId || sourceSessionId === targetSessionId) return;
  // The target record must durably name the source before the source can be
  // removed. That marker also makes a retry after a crash exactly-once: an
  // additive transfer will not count the source twice.
  const target = readLifecycleBudget(cwd, targetSessionId, adapter);
  if (!target?.transferred_from_session_ids?.includes(sourceSessionId)) return;
  rmSync(lifecycleBudgetPath(cwd, sourceSessionId, adapter), { force: true });
}

function legacyPendingBlockPath(
  cwd: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  return join(resolveProjectPath(cwd, adapter.projectPaths.stateRoot), "unclaimed-block.json");
}

function stableDispatchId(sessionId: string, message: string): string {
  return createHash("sha256").update(`${sessionId}\0${message}`).digest("hex");
}

export function createPendingCompletionBlock(
  sessionId: string,
  message: string,
  dispatchId = stableDispatchId(sessionId, message),
  ownerPid = process.pid,
  ownerProcessStart = processIncarnation(ownerPid),
  stopOrder?: number,
  branchName?: string,
): PendingCompletionBlock {
  return {
    schema_version: 2,
    kind: "completion-block",
    dispatch_id: dispatchId,
    session_id: sessionId,
    message,
    owner_pid: ownerPid,
    ...(ownerProcessStart ? { owner_process_start: ownerProcessStart } : {}),
    ...(stopOrder !== undefined ? { stop_order: stopOrder } : {}),
    ...(branchName !== undefined ? { branch_name: branchName } : {}),
  };
}

export function scopePendingBlockToBranch(
  block: PendingCompletionBlock,
  branchName: string | undefined,
): PendingCompletionBlock {
  return branchName && block.branch_name === undefined
    ? { ...block, branch_name: branchName }
    : block;
}

function writePendingBlockAtPath(path: string, block: PendingCompletionBlock): void {
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(block)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function writePendingBlock(
  cwd: string,
  pathSessionId: string,
  block: PendingCompletionBlock,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  writePendingBlockAtPath(pendingBlockPath(cwd, pathSessionId, adapter), block);
}

export function persistPendingBlock(
  cwd: string,
  sessionId: string,
  message: string,
  dispatchId = stableDispatchId(sessionId, message),
  ownerPid = process.pid,
  ownerProcessStart = processIncarnation(ownerPid),
  stopOrder?: number,
  branchName?: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  const block = createPendingCompletionBlock(
    sessionId,
    message,
    dispatchId,
    ownerPid,
    ownerProcessStart,
    stopOrder,
  );
  const scopedBranchName = branchName ?? currentBranchName(cwd);
  writePendingBlock(
    cwd,
    sessionId,
    scopedBranchName ? { ...block, branch_name: scopedBranchName } : block,
    adapter,
  );
}

function parsePendingBlock(value: unknown, fallbackSessionId: string): PendingCompletionBlock | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string") return undefined;
  if (record.schema_version === 2 && record.kind === "completion-block") {
    if (typeof record.dispatch_id !== "string" || typeof record.session_id !== "string") return undefined;
    return {
      schema_version: 2,
      kind: "completion-block",
      dispatch_id: record.dispatch_id,
      session_id: record.session_id,
      message: record.message,
      ...(typeof record.owner_pid === "number" && Number.isInteger(record.owner_pid)
        ? { owner_pid: record.owner_pid }
        : {}),
      ...(typeof record.owner_process_start === "string"
        ? { owner_process_start: record.owner_process_start }
        : {}),
      ...(typeof record.branch_name === "string" ? { branch_name: record.branch_name } : {}),
      ...(typeof record.delivery_runtime_id === "string"
        ? { delivery_runtime_id: record.delivery_runtime_id }
        : {}),
      ...(typeof record.stop_order === "number" && Number.isSafeInteger(record.stop_order) && record.stop_order >= 0
        ? { stop_order: record.stop_order }
        : {}),
      ...(typeof record.budget_source_session_id === "string"
        ? { budget_source_session_id: record.budget_source_session_id }
        : {}),
      ...(typeof record.budget_transfer_source_session_id === "string"
        ? { budget_transfer_source_session_id: record.budget_transfer_source_session_id }
        : {}),
    };
  }
  if (record.schema_version !== 1) return undefined;
  return createPendingCompletionBlock(fallbackSessionId, record.message);
}

export function readPendingBlock(
  cwd: string,
  sessionId: string,
  orphanedSessionId?: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const path = pendingBlockPath(cwd, sessionId, adapter);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const pending = parsePendingBlock(raw, sessionId);
    if (!pending) return undefined;
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>).schema_version === 1
    ) {
      const branchName = currentBranchName(cwd);
      const migrated = branchName ? { ...pending, branch_name: branchName } : pending;
      writePendingBlockAtPath(path, migrated);
      return isPendingBlockForCurrentBranch(cwd, migrated) ? migrated : undefined;
    }
    return isPendingBlockForCurrentBranch(cwd, pending) ? pending : undefined;
  } catch {
    const claimCandidates = [legacyPendingBlockPath(cwd, adapter)];
    if (orphanedSessionId && orphanedSessionId !== sessionId) {
      claimCandidates.push(pendingBlockPath(cwd, orphanedSessionId, adapter));
    }
    for (const candidate of claimCandidates) {
      try {
        renameSync(candidate, path);
        return readPendingBlock(cwd, sessionId, undefined, adapter);
      } catch {
        // Another session may have claimed this candidate first.
      }
    }
    return undefined;
  }
}

function readSessionPendingBlock(
  cwd: string,
  sessionId: string,
  branchName: string | undefined | null = null,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const path = pendingBlockPath(cwd, sessionId, adapter);
  const pending = readSessionPendingBlockAtPath(path, sessionId);
  const migrated = pending ? migrateLegacyPendingBlockAtPath(cwd, path, pending) : undefined;
  return migrated && isPendingBlockForCurrentBranch(cwd, migrated, branchName)
    ? migrated
    : undefined;
}

function readSessionPendingBlockAtPath(
  path: string,
  sessionId: string,
): PendingCompletionBlock | undefined {
  try {
    return parsePendingBlock(
      JSON.parse(readFileSync(path, "utf8")),
      sessionId,
    );
  } catch {
    return undefined;
  }
}

function migrateLegacyPendingBlockAtPath(
  cwd: string,
  path: string,
  pending: PendingCompletionBlock,
): PendingCompletionBlock | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.schema_version !== 1) return pending;
    const branchName = currentBranchName(cwd);
    const migrated = branchName ? { ...pending, branch_name: branchName } : pending;
    writePendingBlockAtPath(path, migrated);
    return migrated;
  } catch {
    return undefined;
  }
}

export function processIncarnation(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[19]) return fields[19];
  } catch {
    // macOS has no /proc; use its process start time below.
  }
  try {
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return start || undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number, expectedIncarnation?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!expectedIncarnation) return true;
  const actualIncarnation = processIncarnation(pid);
  return actualIncarnation === undefined || actualIncarnation === expectedIncarnation;
}

/**
 * Claim one pending block whose recorded launcher is demonstrably gone.
 *
 * A runtime replacement keeps the launch-scoped session path and is handled
 * by readPendingBlock(). A fresh launcher gets a new session path, so it
 * recovers only owned schema-v2 records whose owner PID is dead and whose
 * process incarnation no longer matches. Schema-v1 records have no owner
 * identity and are left untouched during orphan recovery.
 * The atomic source rename prevents two replacement launchers from stealing
 * the same record and leaves live concurrent sessions untouched.
 */
export function claimOrphanedPendingBlock(
  candidate: string,
  destination: string,
  rename: (candidate: string, destination: string) => void = renameSync,
): boolean {
  try {
    rename(candidate, destination);
    return true;
  } catch {
    return false;
  }
}

function claimingPendingBlockPath(path: string): string {
  const incarnation = processIncarnation(process.pid);
  const encoded = incarnation ? `-${Buffer.from(incarnation).toString("hex")}` : "";
  return `${path}.claiming-${process.pid}${encoded}`;
}

function refreshingPendingBlockPath(path: string): string {
  const incarnation = processIncarnation(process.pid);
  const encoded = incarnation
    ? `-inc${Buffer.from(incarnation).toString("hex")}`
    : "";
  return `${path}.refreshing-${process.pid}${encoded}-${randomUUID()}`;
}

function claimingProcessId(path: string): number | undefined {
  const match = /\.(?:claiming|refreshing)-(\d+)(?:-inc[0-9a-f]+)?(?:-[0-9a-f-]+)?(?:\.json)?$/.exec(path);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) ? pid : undefined;
}

function claimingProcessIncarnation(path: string): string | undefined {
  const match = /\.claiming-\d+-([0-9a-f]+)(?:\.json)?$/.exec(path) ??
    /\.refreshing-\d+-inc([0-9a-f]+)-[0-9a-f-]+(?:\.json)?$/.exec(path);
  if (!match) return undefined;
  try {
    return Buffer.from(match[1], "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

export function readOrphanedPendingBlock(
  cwd: string,
  sessionId: string,
  hooks: PendingBlockRecoveryHooks = {},
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const existing = readPendingBlock(cwd, sessionId, undefined, adapter);
  if (existing) return existing;

  const path = pendingBlockPath(cwd, sessionId, adapter);
  const directory = dirname(path);
  let candidates: string[];
  try {
    candidates = readdirSync(directory)
      .filter((name) =>
        /^pending-block-[a-f0-9]{64}\.json(?:\.claiming-\d+(?:-[0-9a-f]+)?(?:\.json)?|\.refreshing-\d+(?:-inc[0-9a-f]+)?-[0-9a-f-]+)?$/.test(
          name,
        ),
      )
      .map((name) => join(directory, name))
      .filter((candidate) => candidate !== path);
  } catch {
    return undefined;
  }

  const parsedCandidates: Array<{
    candidate: string;
    raw: Record<string, unknown>;
    claimingPid?: number;
    claimingIncarnation?: string;
  }> = [];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      parsedCandidates.push({
        candidate,
        raw,
        claimingPid: claimingProcessId(candidate),
        claimingIncarnation: claimingProcessIncarnation(candidate),
      });
    } catch {
      // Another launcher may have claimed the candidate, or it may have been
      // removed while the liveness probe was running.
    }
  }

  const branchName = currentBranchName(cwd);
  const v2Candidates = parsedCandidates.filter(({ raw, claimingPid, claimingIncarnation }) => {
    if (raw.schema_version !== 2) return false;
    // A reused worktree can contain blocks from an earlier branch. Never replay
    // one of those into the current task. Older blocks without branch metadata
    // remain recoverable only in non-git scratch/test directories.
    if (branchName ? raw.branch_name !== branchName : raw.branch_name !== undefined) {
      return false;
    }
    if (claimingPid !== undefined && isProcessAlive(claimingPid, claimingIncarnation)) return false;
    return (
      typeof raw.owner_pid === "number" &&
      Number.isInteger(raw.owner_pid) &&
      !isProcessAlive(
        raw.owner_pid,
        typeof raw.owner_process_start === "string" ? raw.owner_process_start : undefined,
      )
    );
  });

  // Schema-v1 records have no owner or process-incarnation identity. Age
  // cannot prove that their original launcher is gone, so leave them alone.
  const candidatesToClaim = v2Candidates;
  for (const { candidate, raw } of candidatesToClaim) {
    const pending = parsePendingBlock(raw, sessionId);
    if (!pending) continue;
    const staging = claimingPendingBlockPath(path);
    if (!claimOrphanedPendingBlock(candidate, staging)) continue;
    const markedBudgetSourceSessionId = pending.budget_source_session_id ??
      (pending.session_id !== sessionId ? pending.session_id : undefined);
    const stagedBudgetSourceSessionId = pending.budget_transfer_source_session_id;
    const markedBudget = markedBudgetSourceSessionId
      ? readLifecycleBudget(cwd, markedBudgetSourceSessionId, adapter)
      : undefined;
    const budgetAlreadyTransferred =
      stagedBudgetSourceSessionId !== undefined &&
      markedBudget?.transferred_from_session_ids?.includes(stagedBudgetSourceSessionId) === true;
    const budgetSourceSessionId = budgetAlreadyTransferred
      ? markedBudgetSourceSessionId
      : stagedBudgetSourceSessionId ?? markedBudgetSourceSessionId;
    // A crash after the budget transfer has published `stagedClaim` leaves the
    // claim owned by the destination. Retain the original source from the
    // staged transfer marker until Stop-order transfer also completes.
    const stopOrderSourceSessionId = pending.session_id !== sessionId
      ? pending.session_id
      : pending.budget_transfer_source_session_id !== undefined &&
          pending.budget_transfer_source_session_id !== sessionId
        ? pending.budget_transfer_source_session_id
        : undefined;
    const competingBeforeClaim = readPendingBlock(cwd, sessionId, undefined, adapter);
    if (competingBeforeClaim) {
      writePendingBlockAtPath(staging, pending);
      try {
        renameSync(staging, candidate);
      } catch {
        // Leave the staging record for the next orphan sweep if restoration
        // races another claimant.
      }
      return competingBeforeClaim;
    }
    const claimed = {
      ...pending,
      session_id: sessionId,
      ...(budgetSourceSessionId ? { budget_source_session_id: budgetSourceSessionId } : {}),
      ...(stagedBudgetSourceSessionId
        ? { budget_transfer_source_session_id: stagedBudgetSourceSessionId }
        : {}),
      owner_pid: process.pid,
      ...(processIncarnation(process.pid)
        ? { owner_process_start: processIncarnation(process.pid) }
        : {}),
    };
    // Record the current owner before deleting the source budget. If this
    // launcher exits between either durable operation, the staged block still
    // names the owner that contains the transferred budget.
    const stagedClaim = budgetSourceSessionId && budgetSourceSessionId !== sessionId
      ? {
          ...claimed,
          budget_source_session_id: sessionId,
          budget_transfer_source_session_id: budgetSourceSessionId,
        }
      : claimed;
    writePendingBlockAtPath(staging, stagedClaim);
    hooks.beforeBudgetCleanup?.();
    const competingAfterClaim = readPendingBlock(cwd, sessionId, undefined, adapter);
    if (competingAfterClaim) {
      writePendingBlockAtPath(staging, pending);
      try {
        renameSync(staging, candidate);
      } catch {
        // Leave the staging record for the next orphan sweep if restoration
        // races another claimant.
      }
      return competingAfterClaim;
    }
    if (
      budgetSourceSessionId &&
      budgetSourceSessionId !== sessionId &&
      !transferLifecycleBudget(cwd, budgetSourceSessionId, sessionId, adapter)
    ) {
      try {
        renameSync(staging, candidate);
      } catch {
        // Another claimant may have taken the staging record already.
      }
      continue;
    }
    if (
      stopOrderSourceSessionId &&
      !transferStopOrderState(cwd, stopOrderSourceSessionId, sessionId, pending.stop_order, adapter)
    ) {
      const requeued = {
        ...stagedClaim,
        owner_pid: pending.owner_pid,
        ...(pending.owner_process_start
          ? { owner_process_start: pending.owner_process_start }
          : {}),
      };
      writePendingBlockAtPath(staging, requeued);
      try {
        renameSync(staging, candidate);
      } catch {
        // Another claimant may have taken the staging record already.
      }
      continue;
    }
    cleanupTransferredLifecycleBudget(cwd, budgetSourceSessionId, sessionId, adapter);
    cleanupTransferredStopOrderState(cwd, stopOrderSourceSessionId, sessionId, adapter);
    if (budgetAlreadyTransferred && stagedBudgetSourceSessionId) {
      cleanupTransferredLifecycleBudget(cwd, stagedBudgetSourceSessionId, sessionId, adapter);
    }
    hooks.afterBudgetTransfer?.();
    const competingAfterTransfer = readPendingBlock(cwd, sessionId, undefined, adapter);
    if (competingAfterTransfer) {
      // The destination won a race after the budget transfer. Requeue the
      // staged claim under its original dead-owner identity so this launcher
      // can recover it after the competing prompt is consumed. Leaving it in
      // a live `.claiming-<pid>` path would make every future orphan sweep
      // skip it indefinitely.
      const requeued = {
        ...stagedClaim,
        owner_pid: pending.owner_pid,
        ...(pending.owner_process_start
          ? { owner_process_start: pending.owner_process_start }
          : {}),
      };
      writePendingBlockAtPath(staging, requeued);
      try {
        renameSync(staging, candidate);
      } catch {
        // Leave the staging record for the next orphan sweep if restoration
        // races another claimant.
      }
      return competingAfterTransfer;
    }
    if (existsSync(path)) {
      // A destination from another branch is stale, not a competing claim.
      // Quarantine it only after the branch-aware read above has rejected it,
      // then publish the recovered current-branch block. Leaving the
      // quarantine on a crash keeps the stale bytes recoverable for an
      // operator without making it look like a live pending block.
      const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(path, stalePath);
      } catch {
        return undefined;
      }
    }
    renameSync(staging, path);
    return readPendingBlock(cwd, sessionId, undefined, adapter);
  }
  return undefined;
}

export function markPendingBlockDelivered(
  cwd: string,
  sessionId: string,
  runtimeId: string,
  block: PendingCompletionBlock,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const current = readSessionPendingBlock(cwd, sessionId, null, adapter);
  if (!current || current.dispatch_id !== block.dispatch_id) return undefined;
  if (current.delivery_runtime_id === runtimeId) return undefined;
  const delivered = { ...current, delivery_runtime_id: runtimeId };
  writePendingBlock(cwd, sessionId, delivered, adapter);
  return delivered;
}

interface PendingBlockDeliveryQueue {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly deliveries: readonly PendingCompletionBlock[];
}

function pendingBlockDeliveryQueuePath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const sessionIdentity = createHash("sha256").update(sessionId).digest("hex");
  return join(
    resolveProjectPath(cwd, adapter.projectPaths.stateRoot),
    `pending-block-deliveries-${sessionIdentity}.json`,
  );
}

export function readPendingBlockDeliveries(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock[] {
  if (!sessionId) return [];
  try {
    const record = JSON.parse(
      readFileSync(pendingBlockDeliveryQueuePath(cwd, sessionId, adapter), "utf8"),
    ) as Record<string, unknown>;
    if (
      record.schema_version !== 1 ||
      record.session_id !== sessionId ||
      !Array.isArray(record.deliveries)
    ) {
      return [];
    }
    return record.deliveries
      .map((delivery) => parsePendingBlock(delivery, sessionId))
      .filter(
        (delivery): delivery is PendingCompletionBlock =>
          delivery !== undefined &&
          delivery.session_id === sessionId &&
          isPendingBlockForCurrentBranch(cwd, delivery),
      );
  } catch {
    return [];
  }
}

function writePendingBlockDeliveries(
  cwd: string,
  sessionId: string,
  deliveries: readonly PendingCompletionBlock[],
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  const path = pendingBlockDeliveryQueuePath(cwd, sessionId, adapter);
  if (deliveries.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  const queue: PendingBlockDeliveryQueue = {
    schema_version: 1,
    session_id: sessionId,
    deliveries,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(queue)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function persistPendingBlockDelivery(
  cwd: string,
  sessionId: string,
  block: PendingCompletionBlock,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sessionId || block.session_id !== sessionId) return;
  const path = pendingBlockDeliveryQueuePath(cwd, sessionId, adapter);
  withLifecycleBudgetLock(path, () => {
    const deliveries = readPendingBlockDeliveries(cwd, sessionId, adapter).filter(
      (delivery) => delivery.dispatch_id !== block.dispatch_id,
    );
    writePendingBlockDeliveries(cwd, sessionId, [...deliveries, block], adapter);
  });
}

function removePendingBlockDelivery(
  cwd: string,
  sessionId: string,
  dispatchId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  if (!sessionId || !dispatchId) return;
  const path = pendingBlockDeliveryQueuePath(cwd, sessionId, adapter);
  withLifecycleBudgetLock(path, () => {
    const deliveries = readPendingBlockDeliveries(cwd, sessionId, adapter).filter(
      (delivery) => delivery.dispatch_id !== dispatchId,
    );
    writePendingBlockDeliveries(cwd, sessionId, deliveries, adapter);
  });
}

/**
 * Select the dispatch whose prompt was consumed when multiple accepted
 * completion deliveries have identical text. Pi's message_start event carries
 * the prompt but not the dispatch id, so preserve delivery order in memory and
 * consume the oldest matching identity rather than whichever delivery was
 * assigned to the single latest-awaiting slot.
 */
export function consumePendingBlockDelivery(
  deliveries: readonly PendingCompletionBlock[],
  prompt: string,
): {
  readonly block?: PendingCompletionBlock;
  readonly remaining: PendingCompletionBlock[];
} {
  const index = deliveries.findIndex((delivery) => delivery.message === prompt);
  if (index < 0) return { remaining: [...deliveries] };
  return {
    block: deliveries[index],
    remaining: [...deliveries.slice(0, index), ...deliveries.slice(index + 1)],
  };
}

function refreshPendingBlockOwner(
  cwd: string,
  sessionId: string,
  block: PendingCompletionBlock,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const path = pendingBlockPath(cwd, sessionId, adapter);
  const current = readSessionPendingBlock(cwd, sessionId, null, adapter);
  if (!current || current.dispatch_id !== block.dispatch_id) return undefined;

  const claimedPath = refreshingPendingBlockPath(path);
  try {
    renameSync(path, claimedPath);
  } catch {
    return undefined;
  }

  const claimed = readSessionPendingBlockAtPath(claimedPath, sessionId);
  if (!claimed || claimed.dispatch_id !== block.dispatch_id) {
    try {
      linkSync(claimedPath, path);
      rmSync(claimedPath, { force: true });
    } catch {
      if (existsSync(path)) rmSync(claimedPath, { force: true });
    }
    return undefined;
  }

  const refreshed = {
    ...claimed,
    owner_pid: process.pid,
    ...(processIncarnation(process.pid)
      ? { owner_process_start: processIncarnation(process.pid) }
      : {}),
  };
  writePendingBlockAtPath(claimedPath, refreshed);
  try {
    linkSync(claimedPath, path);
    rmSync(claimedPath, { force: true });
    return refreshed;
  } catch {
    if (existsSync(path)) {
      rmSync(claimedPath, { force: true });
      return undefined;
    }
    try {
      renameSync(claimedPath, path);
      return refreshed;
    } catch {
      return undefined;
    }
  }
}

export function replayPendingCompletionBlock(
  cwd: string,
  sessionId: string,
  _runtimeId: string,
  sendUserMessage: (content: string) => boolean,
  orphanedSessionId?: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): PendingCompletionBlock | undefined {
  const pending =
    readSessionPendingBlock(cwd, sessionId, null, adapter) ??
    (orphanedSessionId
      ? readPendingBlock(cwd, sessionId, orphanedSessionId, adapter)
      : undefined);
  if (!pending) return undefined;
  const refreshed = refreshPendingBlockOwner(cwd, sessionId, pending, adapter);
  if (!refreshed) return undefined;
  const replay = refreshed.delivery_runtime_id && refreshed.delivery_runtime_id !== _runtimeId
    ? { ...refreshed, delivery_runtime_id: _runtimeId }
    : refreshed;
  if (replay !== refreshed) writePendingBlock(cwd, sessionId, replay, adapter);
  if (!sendUserMessage(replay.message)) return undefined;
  // The synchronous Pi wrapper only submits the prompt. Durable delivery
  // bookkeeping is performed by before_agent_start/message_start after Pi has
  // accepted and consumed the exact prompt.
  return replay;
}

export function shouldAttemptPendingBlockReplay(
  pending: PendingCompletionBlock | undefined,
  awaiting: PendingCompletionBlock | undefined,
  retryAt: number,
  now = Date.now(),
): boolean {
  if (!pending || awaiting?.dispatch_id === pending.dispatch_id) return false;
  return now >= retryAt;
}

/**
 * A void Pi send can fail asynchronously without returning a thenable. Retry
 * only after the bounded quiet-runtime deadline; an active agent turn keeps a
 * queued follow-up in flight so long turns cannot accumulate duplicate blocks.
 */
export function shouldRetryPendingBlockDelivery(
  awaiting: PendingCompletionBlock | undefined,
  agentTurnActive: boolean,
  retryAt: number,
  now = Date.now(),
): boolean {
  // The pinned ExtensionAPI wrapper returns void and catches the underlying
  // sendUserMessage promise, so rejected idle submissions are not observable
  // by this extension. Keep a generous preflight grace period and only retry
  // once the runtime is still quiet; agent_start/message_start acknowledgement
  // clears this state first and prevents duplicate turns.
  return Boolean(awaiting && !agentTurnActive && retryAt > 0 && now >= retryAt);
}

export function acknowledgePendingBlock(
  cwd: string,
  sessionId: string,
  runtimeId: string,
  dispatchId: string,
  renamePendingBlock: (source: string, destination: string) => void = renameSync,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  const path = pendingBlockPath(cwd, sessionId, adapter);
  const current = readSessionPendingBlock(cwd, sessionId, null, adapter);
  if (!current || current.dispatch_id !== dispatchId) return;
  if (current.delivery_runtime_id && current.delivery_runtime_id !== runtimeId) return;

  const claimedPath = `${path}.acknowledging-${process.pid}-${randomUUID()}`;
  try {
    renamePendingBlock(path, claimedPath);
  } catch {
    return;
  }

  let claimed: PendingCompletionBlock | undefined;
  try {
    claimed = parsePendingBlock(JSON.parse(readFileSync(claimedPath, "utf8")), sessionId);
  } catch {
    claimed = undefined;
  }
  if (
    !claimed ||
    claimed.dispatch_id !== dispatchId ||
    (claimed.delivery_runtime_id && claimed.delivery_runtime_id !== runtimeId)
  ) {
    try {
      // A replacement may have arrived after the claim. A hard link restores
      // the old record only when the path is still absent, never overwriting it.
      linkSync(claimedPath, path);
      rmSync(claimedPath, { force: true });
    } catch {
      if (existsSync(path)) rmSync(claimedPath, { force: true });
    }
    return;
  }
  rmSync(claimedPath, { force: true });
}

/**
 * Acknowledge a replay only after Pi has emitted the exact user prompt in
 * message_start. Earlier lifecycle hooks run before asynchronous prompt
 * validation and could clear a block for an unrelated competing turn.
 */
export function acknowledgePendingBlockForPrompt(
  cwd: string,
  sessionId: string,
  runtimeId: string,
  block: PendingCompletionBlock,
  prompt: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): boolean {
  if (prompt !== block.message) return false;
  acknowledgePendingBlock(cwd, sessionId, runtimeId, block.dispatch_id, renameSync, adapter);
  return readSessionPendingBlock(cwd, sessionId, null, adapter) === undefined;
}

function pendingSummaryPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const identity = createHash("sha256").update(sessionId).digest("hex");
  return join(resolveProjectPath(cwd, adapter.projectPaths.stateRoot), `unclaimed-summary-${identity}.txt`);
}

function deliveredSummaryPath(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string {
  const identity = createHash("sha256").update(sessionId).digest("hex");
  return join(resolveProjectPath(cwd, adapter.projectPaths.stateRoot), `last-delivered-summary-${identity}.txt`);
}

function persistPendingSummary(
  cwd: string,
  sessionId: string,
  summary: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): void {
  const path = pendingSummaryPath(cwd, sessionId, adapter);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${summary}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readPendingSummary(
  cwd: string,
  sessionId: string,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): string | undefined {
  try {
    return readFileSync(pendingSummaryPath(cwd, sessionId, adapter), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts a `tool_response`-shaped payload from a Pi `tool_result` event so
 * dispatch.py's fan-out hooks (in particular response-budget-guard.py, which
 * bails whenever `tool_response` is absent) receive the actual tool output,
 * not just its name and original input (PR 3535 review round 1 P1 finding 1).
 * `content` entries are `TextContent | ImageContent`; images are summarized
 * rather than inlined so the payload stays small and JSON-safe.
 */
export function toolResponseFromEvent(event: ToolResultEvent): Record<string, unknown> {
  const text = event.content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}]`))
    .join("");
  return { text, isError: event.isError };
}

/** Builds the PostToolUse dispatch payload for a `tool_result` event,
 * factored out so it can be asserted on directly in behavioral tests
 * without wiring a real `pi.on(...)` extension context. `modelContext`
 * supplies the `model`/`context_window` keys
 * the response-budget policy calibrates its thresholds from
 * (PR 3535 review round 2 P1 finding D); both are omitted when unresolved
 * rather than sent as `undefined`. */
export function buildToolResultPayload(
  event: ToolResultEvent,
  cwd: string,
  sessionId: string,
  modelContext: ModelContext = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cwd,
    tool_name: event.toolName,
    tool_input: event.input,
    tool_response: toolResponseFromEvent(event),
    session_id: sessionId,
  };
  if (modelContext.model !== undefined) payload.model = modelContext.model;
  if (modelContext.contextWindow !== undefined) payload.context_window = modelContext.contextWindow;
  return payload;
}

/** A `Stop` dispatch result is a synthetic EXTENSION-BOUNDARY failure
 * (dispatch.py missing/crashed/produced malformed stdout) precisely when it
 * carries a `teardown_warnings` entry — dispatch.py itself only ever
 * populates that field on SessionStart/SessionEnd, never on Stop, so a
 * non-empty entry here can only be `lib/dispatch.ts`'s
 * `emptyDispatchResult(...)` synthesized diagnostic, never a real dispatch.py
 * output (PR 3535 review round 2 P1 finding B — a broken dispatch.py must
 * never look identical to "nothing to report"). */
function isStopDispatchFailure(result: DispatchResult): boolean {
  return result.teardown_warnings.length > 0;
}

export const REENGAGE_LIMIT = 5;

// Stop dispatch allows 15s + 10s + a 5s git_repo probe + 15s. Keep the
// replacement-runtime replay probe open for that budget and continue bounded,
// coarse orphan rechecks so an owner that exits just after the first sweep is
// still recoverable without another launcher restart.
export const PENDING_BLOCK_REPLAY_MAX_ATTEMPTS = 600;
export const PENDING_BLOCK_ORPHAN_RECOVERY_INTERVAL_MS = 5_000;

export function resetPendingBlockReplayState(now = Date.now()): {
  attempts: number;
  started_at: number;
  last_orphan_recovery_at: number;
} {
  return {
    attempts: 0,
    started_at: now,
    last_orphan_recovery_at: 0,
  };
}

/** Consecutive Stop-dispatch-invocation failures tolerated before releasing
 * (allowing) rather than wedging every completion attempt forever — mirrors
 * agent-pi-harness-warden.ts's `EXTENSION_FAILURE_RELEASE_THRESHOLD` (PR 3535 review
 * round 2 P1 finding B). */
export const STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD = 3;

export interface LifecycleHandlerDeps {
  readonly runDispatch: RunDispatch;
  readonly adapter: ProjectAdapterV1;
  /** Writes the blocked color before Pi is asked to launch a re-engagement. */
  readonly beforeReengagement?: () => Promise<void>;
  readonly sendUserMessage: (
    content: string,
    completionBlock?: PendingCompletionBlock,
  ) => void | Promise<void>;
  readonly sendMessage: (content: string) => void | Promise<void>;
  /** Persists a durable session entry — used for teardown warnings raised at
   * SessionStart/SessionEnd, which `sendMessage` cannot reliably surface at
   * shutdown (the session is already tearing down). */
  readonly appendEntry: (customType: string, data?: unknown) => void;
}

export interface LifecycleHandlers {
  onSessionStart: (cwd: string, payload: Record<string, unknown>) => Promise<DispatchResult>;
  onSessionShutdown: (cwd: string, payload: Record<string, unknown>) => Promise<DispatchResult>;
  onToolResult: (cwd: string, payload: Record<string, unknown>) => Promise<void>;
  onInput: (cwd: string, payload: Record<string, unknown>) => Promise<void>;
  onAgentSettled: (cwd: string, payload: Record<string, unknown>) => Promise<AgentSettledOutcome>;
  reengageCount: () => number;
  stopDispatchFailureCount: () => number;
}

/**
 * Builds the five lifecycle handlers over an injectable `deps`, decoupled
 * from `pi.on(...)` wiring so they can be exercised directly against a
 * stubbed `runDispatch` (bead AC: a runnable behavioral test).
 */
export function createLifecycleHandlers(deps: LifecycleHandlerDeps): LifecycleHandlers {
  const adapter = validateProjectAdapterV1(deps.adapter);
  let reengageCount = 0;
  let stopDispatchFailureCount = 0;
  let budgetCwd = "";
  let budgetSessionId = "";
  const fallbackSessionId = `pi-lifecycle-${randomUUID()}`;

  function withSessionIdentity(payload: Record<string, unknown>): Record<string, unknown> {
    return typeof payload.session_id === "string" && payload.session_id
      ? payload
      : { ...payload, session_id: fallbackSessionId };
  }

  function persistBudget(mutation: LifecycleBudgetMutation = {}): LifecycleBudgetUpdate | undefined {
    const updated = updateLifecycleBudget(budgetCwd, budgetSessionId, mutation, adapter);
    if (updated) {
      reengageCount = updated.budget.reengage_count;
      stopDispatchFailureCount = updated.budget.stop_dispatch_failure_count;
    }
    return updated;
  }

  function completionBlock(payload: Record<string, unknown>, message: string): PendingCompletionBlock {
    const sessionId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : fallbackSessionId;
    const dispatchId =
      typeof payload.dispatch_id === "string" && payload.dispatch_id
        ? payload.dispatch_id
        : stableDispatchId(sessionId, message);
    const stopOrder = payload.stop_order;
    const branchName = typeof payload.branch_name === "string" ? payload.branch_name : undefined;
    return createPendingCompletionBlock(
      sessionId,
      message,
      dispatchId,
      process.pid,
      processIncarnation(process.pid),
      typeof stopOrder === "number" && Number.isSafeInteger(stopOrder) && stopOrder >= 0
        ? stopOrder
        : undefined,
      branchName,
    );
  }

  /** Surfaces `teardown_warnings` (surviving pids, held flocks) that
   * SessionStart's stale-owner sweep and SessionEnd's teardown-by-owner can
   * both return — previously discarded, leaving leaked effects invisible to
   * the operator (PR 3535 review round 1 P2 finding 6). */
  function surfaceTeardownWarnings(source: "SessionStart" | "SessionEnd", result: DispatchResult): void {
    if (result.teardown_warnings.length === 0) return;
    deps.appendEntry("agent-pi-harness-lifecycle-teardown-warning", {
      source,
      warnings: result.teardown_warnings,
    });
  }

  async function onSessionStart(
    cwd: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    payload = withSessionIdentity(payload);
    budgetCwd = cwd;
    budgetSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const persisted = readLifecycleBudget(budgetCwd, budgetSessionId, adapter);
    reengageCount = persisted?.reengage_count ?? 0;
    stopDispatchFailureCount = persisted?.stop_dispatch_failure_count ?? 0;
    const result = await deps.runDispatch("SessionStart", cwd, payload, adapter);
    surfaceTeardownWarnings("SessionStart", result);
    return result;
  }

  async function onSessionShutdown(
    cwd: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    payload = withSessionIdentity(payload);
    const result = await deps.runDispatch("SessionEnd", cwd, payload, adapter);
    surfaceTeardownWarnings("SessionEnd", result);
    if (payload.reason === "quit") {
      cleanupCompletedLifecycleState(
        cwd,
        typeof payload.session_id === "string" ? payload.session_id : "",
        adapter,
      );
    }
    return result;
  }

  async function onToolResult(cwd: string, payload: Record<string, unknown>): Promise<void> {
    payload = withSessionIdentity(payload);
    const result = await deps.runDispatch("PostToolUse", cwd, payload, adapter);
    if (result.block) {
      await deps.sendMessage(result.block_reason);
      return;
    }
    const advisory = collectAdvisoryText(result);
    if (advisory) {
      await deps.sendMessage(boundLength(advisory, ADVISORY_MAX_LENGTH));
    }
  }

  async function onInput(cwd: string, payload: Record<string, unknown>): Promise<void> {
    payload = withSessionIdentity(payload);
    // A manual prompt starts a fresh unit of work. Pi also emits input for
    // extension-injected re-engagement, which must preserve the automatic
    // Stop-dispatch failure state until the retry settles.
    if (payload.source !== "extension" && !payload.streamingBehavior) {
      const reset = persistBudget({
        resetStopDispatchFailure: true,
        preserveStopDispatchFailureOrder: true,
      });
      if (!reset) stopDispatchFailureCount = 0;
    }
    const result = await deps.runDispatch("UserPromptSubmit", cwd, payload, adapter);
    if (result.block) {
      await deps.sendMessage(result.block_reason);
      return;
    }
    const advisory = collectAdvisoryText(result);
    if (advisory) {
      await deps.sendMessage(boundLength(advisory, ADVISORY_MAX_LENGTH));
    }
  }

  /** A failed Stop dispatch used to fail OPEN (`block: false`), so
   * `onAgentSettled` returned immediately and silently bypassed every
   * completion hook on the very first infrastructure failure (PR 3535
   * review round 2 P1 finding B). This now treats a failure as blocking —
   * re-engaging via `sendUserMessage` up to `REENGAGE_LIMIT`, same as a real
   * policy block — until `STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD`
   * consecutive failures, at which point it releases with a loud
   * `sendMessage` diagnostic rather than wedging completion forever. */
  async function handleStopDispatchFailure(
    result: DispatchResult,
    payload: Record<string, unknown>,
    cwd: string,
  ): Promise<AgentSettledOutcome> {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const stopOrder = payload.stop_order;
    const failureUpdate = persistBudget({
      stopDispatchFailureDelta: 1,
      ...(typeof stopOrder === "number" && Number.isSafeInteger(stopOrder) && stopOrder >= 0
        ? { stopDispatchFailureOrder: stopOrder }
        : {}),
    });
    if (!failureUpdate) stopDispatchFailureCount += 1;
    const originalError = result.teardown_warnings.join("; ");
    if (stopDispatchFailureCount >= STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD) {
      const pending = sessionId
        ? readSessionPendingBlock(cwd, sessionId, null, adapter)
        : undefined;
      if (pending?.message.startsWith("Stop dispatch failed —")) {
        acknowledgePendingBlock(
          cwd,
          sessionId,
          pending.delivery_runtime_id ?? "",
          pending.dispatch_id,
          renameSync,
          adapter,
        );
      }
      await deps.sendMessage(
        `Stop dispatch released after ${stopDispatchFailureCount} consecutive failures — ` +
          `fix dispatch.py. Original error: ${originalError}`,
      );
      return "dispatch_failed";
    }
    if (reengageCount < REENGAGE_LIMIT) {
      const reengageUpdate = persistBudget({
        reengageDelta: 1,
        reengageLimit: REENGAGE_LIMIT,
      });
      if (reengageUpdate && !reengageUpdate.reengageIncremented) return "dispatch_failed";
      if (!reengageUpdate) reengageCount += 1;
      await deps.beforeReengagement?.();
      const message =
        `Stop dispatch failed — treating as incomplete work (fail-closed). ` +
          `Original error: ${originalError}`;
      const latestHealthyOrder = latestHealthyStopOrder(cwd, sessionId, adapter);
      if (
        latestHealthyOrder !== undefined &&
        typeof stopOrder === "number" &&
        Number.isSafeInteger(stopOrder) &&
        stopOrder >= 0 &&
        stopOrder <= latestHealthyOrder
      ) {
        return "completed";
      }
      const latestPending = sessionId
        ? readSessionPendingBlock(cwd, sessionId, null, adapter)
        : undefined;
      if (
        latestPending?.stop_order !== undefined &&
        typeof stopOrder === "number" &&
        Number.isSafeInteger(stopOrder) &&
        stopOrder >= 0 &&
        latestPending.stop_order > stopOrder
      ) {
        return "completed";
      }
      await deps.sendUserMessage(message, completionBlock(payload, message));
      return "dispatch_failed";
    }
    return "dispatch_failed";
  }

  async function onAgentSettled(
    cwd: string,
    payload: Record<string, unknown>,
  ): Promise<AgentSettledOutcome> {
    payload = withSessionIdentity(payload);
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const branchName = currentBranchName(cwd);
    const payloadStopOrder = payload.stop_order;
    const allocatedStopOrder =
      typeof payloadStopOrder === "number" &&
      Number.isSafeInteger(payloadStopOrder) &&
      payloadStopOrder >= 0
        ? payloadStopOrder
        : allocateStopOrder(cwd, sessionId, adapter);
    if (allocatedStopOrder === undefined) {
      return handleStopDispatchFailure(
        {
          results: [],
          block: false,
          block_reason: "",
          torn_down: [],
          teardown_warnings: [
            "Stop ordering unavailable — completion was not recorded; retry after the lifecycle state lock clears.",
          ],
        },
        { ...payload, ...(branchName !== undefined ? { branch_name: branchName } : {}) },
        cwd,
      );
    }
    const stopOrder = allocatedStopOrder;
    const orderedPayload = {
      ...payload,
      stop_order: stopOrder,
      ...(branchName !== undefined ? { branch_name: branchName } : {}),
    };
    const result = await deps.runDispatch("Stop", cwd, orderedPayload, adapter);

    if (isStopDispatchFailure(result)) {
      const pending = sessionId
        ? readSessionPendingBlock(cwd, sessionId, null, adapter)
        : undefined;
      if (pending?.stop_order !== undefined && pending.stop_order > stopOrder) return "completed";
      const healthyOrder = latestHealthyStopOrder(cwd, sessionId, adapter);
      if (healthyOrder !== undefined && stopOrder <= healthyOrder) return "completed";
      return handleStopDispatchFailure(result, orderedPayload, cwd);
    }
    const failureOrder = readLifecycleBudget(cwd, sessionId, adapter)?.latest_stop_dispatch_failure_order;
    const healthyUpdate = persistBudget(
      failureOrder !== undefined && failureOrder > stopOrder
        ? {}
        : { resetStopDispatchFailure: true },
    );
    if (!healthyUpdate && !(failureOrder !== undefined && failureOrder > stopOrder)) {
      stopDispatchFailureCount = 0;
    }

    if (result.block) {
      // A newer healthy Stop may have completed while this older dispatch
      // was still running. Its ordering identity retires this result before
      // it can recreate a completion block for work that already passed.
      const healthyOrder = latestHealthyStopOrder(cwd, sessionId, adapter);
      if (healthyOrder !== undefined && stopOrder <= healthyOrder) return "completed";
      const pending = sessionId
        ? readSessionPendingBlock(cwd, sessionId, null, adapter)
        : undefined;
      if (pending?.stop_order !== undefined && pending.stop_order > stopOrder) return "completed";
      if (reengageCount < REENGAGE_LIMIT) {
        const reengageUpdate = persistBudget({
          reengageDelta: 1,
          reengageLimit: REENGAGE_LIMIT,
        });
        if (reengageUpdate && !reengageUpdate.reengageIncremented) return "blocked";
        if (!reengageUpdate) reengageCount += 1;
        await deps.beforeReengagement?.();
        // The preparation hook can yield to another Stop handler. Recheck
        // durable ordering after that yield so an older block cannot overwrite
        // a newer completion block that was persisted while it was paused.
        const latestHealthyOrder = latestHealthyStopOrder(cwd, sessionId, adapter);
        if (latestHealthyOrder !== undefined && stopOrder <= latestHealthyOrder) return "completed";
        const latestPending = sessionId
          ? readSessionPendingBlock(cwd, sessionId, null, adapter)
          : undefined;
        if (latestPending?.stop_order !== undefined && latestPending.stop_order > stopOrder) {
          return "completed";
        }
        await deps.sendUserMessage(
          result.block_reason,
          completionBlock(orderedPayload, result.block_reason),
        );
        return "reengaged";
      }
      return "blocked";
    }

    if (!recordHealthyStopOrder(cwd, sessionId, stopOrder, adapter)) {
      return handleStopDispatchFailure(
        {
          results: [],
          block: false,
          block_reason: "",
          torn_down: [],
          teardown_warnings: [
            "Stop ordering unavailable — completion was not recorded; retry after the lifecycle state lock clears.",
          ],
        },
        orderedPayload,
        cwd,
      );
    }
    const superseded = sessionId
      ? readSessionPendingBlock(cwd, sessionId, null, adapter)
      : undefined;
    if (superseded?.stop_order !== undefined && superseded.stop_order < stopOrder) {
      acknowledgePendingBlock(
        cwd,
        sessionId,
        superseded.delivery_runtime_id ?? "",
        superseded.dispatch_id,
        renameSync,
        adapter,
      );
    }

    // Surface non-blocking Stop advisories (e.g.
    // stop-worktree-tmp-artifacts.py's leaked-path warning, or the
    // completion gate's fail-open gh warning) instead of discarding every
    // result stream on an early return (PR 3535 review round 2 P2 finding G).
    const advisory = collectAdvisoryText(result);
    if (advisory) {
      await deps.sendMessage(boundLength(advisory, ADVISORY_MAX_LENGTH));
    }
    return "completed";
  }

  return {
    onSessionStart,
    onSessionShutdown,
    onToolResult,
    onInput,
    onAgentSettled,
    reengageCount: () => reengageCount,
    stopDispatchFailureCount: () => stopDispatchFailureCount,
  };
}

export function registerLifecycle(
  pi: ExtensionAPI,
  adapter: ProjectAdapterV1,
): void {
  adapter = validateProjectAdapterV1(adapter);
  let projectCwd = process.cwd();
  let currentSessionId = "unknown";
  let currentRuntimeId = randomUUID();
  let awaitingBlockDelivery: PendingCompletionBlock | undefined;
  let awaitingBlockDeliveries: PendingCompletionBlock[] = [];
  let pendingBlockReplayTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingBlockReplayAttempts = 0;
  let pendingBlockReplayStartedAt = 0;
  let pendingBlockDeliveryRetryAt = 0;
  let pendingBlockLastOrphanRecoveryAt = 0;
  let replayBranchName: string | undefined;
  let agentTurnActive = false;
  let activeTurnId: string | undefined;
  let latestSummary = "Pi session ended without an assistant-authored summary.";
  let latestAgentRunNeedsAttention = false;

  const PENDING_BLOCK_REPLAY_INTERVAL_MS = 100;
  const PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS = 30_000;

  function stopPendingBlockReplayPoll(): void {
    if (pendingBlockReplayTimer !== undefined) {
      clearTimeout(pendingBlockReplayTimer);
      pendingBlockReplayTimer = undefined;
    }
  }

  function resetPendingBlockReplayWindow(): void {
    const state = resetPendingBlockReplayState();
    pendingBlockReplayAttempts = state.attempts;
    pendingBlockReplayStartedAt = state.started_at;
    pendingBlockLastOrphanRecoveryAt = state.last_orphan_recovery_at;
  }

  function refreshReplayBranchName(): void {
    replayBranchName = currentBranchName(projectCwd);
  }

  function trackPendingBlockDelivery(block: PendingCompletionBlock): void {
    const scopedBlock = scopePendingBlockToBranch(block, currentBranchName(projectCwd));
    awaitingBlockDeliveries = [
      ...awaitingBlockDeliveries.filter((delivery) => delivery.dispatch_id !== scopedBlock.dispatch_id),
      scopedBlock,
    ];
    awaitingBlockDelivery = scopedBlock;
    persistPendingBlockDelivery(projectCwd, currentSessionId, scopedBlock, adapter);
  }

  function forgetPendingBlockDelivery(
    dispatchId: string | undefined,
    persist = true,
  ): void {
    if (!dispatchId) {
      awaitingBlockDeliveries = [];
      awaitingBlockDelivery = undefined;
      return;
    }
    awaitingBlockDeliveries = awaitingBlockDeliveries.filter(
      (delivery) => delivery.dispatch_id !== dispatchId,
    );
    awaitingBlockDelivery = awaitingBlockDeliveries.at(-1);
    if (persist) removePendingBlockDelivery(projectCwd, currentSessionId, dispatchId, adapter);
  }

  function schedulePendingBlockReplayPoll(): void {
    if (
      pendingBlockReplayTimer !== undefined ||
      pendingBlockReplayAttempts >= PENDING_BLOCK_REPLAY_MAX_ATTEMPTS
    ) {
      return;
    }
    pendingBlockReplayAttempts += 1;
    pendingBlockReplayTimer = setTimeout(() => {
      pendingBlockReplayTimer = undefined;
      replayPendingBlockOnce();
    }, PENDING_BLOCK_REPLAY_INTERVAL_MS);
    pendingBlockReplayTimer.unref?.();
  }

  function handleAsyncDeliveryRejection(
    dispatchId: string | undefined,
    error: unknown,
  ): void {
    if (isStaleRuntimeError(error)) {
      if (!dispatchId || awaitingBlockDelivery?.dispatch_id === dispatchId) {
        forgetPendingBlockDelivery(dispatchId, false);
      }
      stopPendingBlockReplayPoll();
      return;
    }
    if (dispatchId && awaitingBlockDelivery?.dispatch_id === dispatchId) {
      forgetPendingBlockDelivery(dispatchId);
      pendingBlockDeliveryRetryAt = Date.now() + PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS;
      schedulePendingBlockReplayPoll();
    }
    console.error(
      `[agent-pi-harness-lifecycle] user-message delivery rejected${dispatchId ? ` for ${dispatchId}` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function sendUserMessageSafely(
    label: string,
    content: string,
    options: { deliverAs?: "steer" | "followUp" } | undefined,
    dispatchId: string | undefined,
  ): boolean {
    let submission: unknown;
    const accepted = safePiCall(label, () => {
      submission = pi.sendUserMessage(content, options);
    });
    if (
      accepted &&
      submission &&
      typeof (submission as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(submission).catch((error: unknown) => {
        handleAsyncDeliveryRejection(dispatchId, error);
      });
    }
    return accepted;
  }

  function replayPendingBlockOnce(): void {
    // The adapter's session identity is launch-stable across Pi runtime replacement. During
    // the bounded replacement window, read only this launch's path: an older
    // dead launcher's block must not win a race against a late block persisted
    // by the runtime being replaced.
    let pending = readSessionPendingBlock(
      projectCwd,
      currentSessionId,
      replayBranchName,
      adapter,
    );
    if (!pending) {
      const replacementWindowExpired =
        Date.now() - pendingBlockReplayStartedAt >=
        45_000;
      const orphanRecoveryDue =
        replacementWindowExpired &&
        Date.now() - pendingBlockLastOrphanRecoveryAt >=
          PENDING_BLOCK_ORPHAN_RECOVERY_INTERVAL_MS;
      if (orphanRecoveryDue) {
        pendingBlockLastOrphanRecoveryAt = Date.now();
        refreshReplayBranchName();
        pending = readOrphanedPendingBlock(projectCwd, currentSessionId, {}, adapter);
        if (pending) resetPendingBlockReplayWindow();
      }
    }
    if (!pending) {
      schedulePendingBlockReplayPoll();
      return;
    }
    if (shouldRetryPendingBlockDelivery(
      awaitingBlockDelivery,
      agentTurnActive,
      pendingBlockDeliveryRetryAt,
    )) {
      forgetPendingBlockDelivery(awaitingBlockDelivery?.dispatch_id);
    }
    if (
      awaitingBlockDelivery &&
      awaitingBlockDelivery.dispatch_id !== pending.dispatch_id
    ) {
      pendingBlockDeliveryRetryAt = 0;
      forgetPendingBlockDelivery(awaitingBlockDelivery.dispatch_id);
    }
    if (!shouldAttemptPendingBlockReplay(
      pending,
      awaitingBlockDelivery,
      pendingBlockDeliveryRetryAt,
    )) {
      schedulePendingBlockReplayPoll();
      return;
    }
    forgetPendingBlockDelivery(awaitingBlockDelivery?.dispatch_id);
    let staleReplayRuntime = false;
    const replayed = replayPendingCompletionBlock(
      projectCwd,
      currentSessionId,
      currentRuntimeId,
      (message) => {
        const accepted = sendUserMessageSafely(
          "replay pending completion block",
          message,
          { deliverAs: "followUp" },
          pending.dispatch_id,
        );
        if (!accepted) staleReplayRuntime = true;
        return accepted;
      },
      undefined,
      adapter,
    );
    if (staleReplayRuntime) {
      stopPendingBlockReplayPoll();
      return;
    }
    if (replayed) {
      trackPendingBlockDelivery(replayed);
      pendingBlockDeliveryRetryAt = Date.now() + PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS;
      schedulePendingBlockReplayPoll();
      return;
    }
    // A stale Pi call means this closure no longer owns the active runtime;
    // the replacement's session_start starts its own probe. Keep polling only
    // while this runtime can still deliver a block that appears later.
    schedulePendingBlockReplayPoll();
  }

  const handlers = createLifecycleHandlers({
    runDispatch,
    adapter,
    beforeReengagement: async () => {
      await safePiAsyncCall("pre-reengagement tab color", () =>
        setTabColor(pi, projectCwd, tabColorForState("needs_input"), adapter),
      );
    },
    sendUserMessage: (content, completionBlock) => {
      if (completionBlock) {
        // A block persisted after session_start gets the full bounded replay
        // window. Otherwise a long-running prior probe can exhaust its 600
        // attempts just before the failed Stop writes the block.
        stopPendingBlockReplayPoll();
        resetPendingBlockReplayWindow();
        persistPendingBlock(
          projectCwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
          completionBlock.branch_name,
          adapter,
        );
      }
      if (
        sendUserMessageSafely(
          "sendUserMessage",
          content,
          undefined,
          completionBlock?.dispatch_id,
        ) &&
        completionBlock
      ) {
        trackPendingBlockDelivery(completionBlock);
        pendingBlockDeliveryRetryAt = Date.now() + PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS;
        schedulePendingBlockReplayPoll();
      }
    },
    sendMessage: (content) => {
      safePiCall("sendMessage", () =>
        pi.sendMessage({ customType: "agent-pi-harness-lifecycle", content, display: true }),
      );
    },
    appendEntry: (customType, data) => {
      safePiCall("appendEntry", () => pi.appendEntry(customType, data));
    },
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    stopPendingBlockReplayPoll();
    resetPendingBlockReplayWindow();
    pendingBlockDeliveryRetryAt = 0;
    projectCwd = ctx.cwd;
    refreshReplayBranchName();
    currentSessionId = resolveSessionId(ctx, adapter);
    currentRuntimeId = randomUUID();
    awaitingBlockDeliveries = readPendingBlockDeliveries(projectCwd, currentSessionId, adapter);
    awaitingBlockDelivery = awaitingBlockDeliveries.at(-1);
    pendingBlockDeliveryRetryAt = awaitingBlockDelivery
      ? Date.now() + PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS
      : 0;
    const inheritedActiveTurn = readActiveTurn(projectCwd, currentSessionId, adapter);
    if (inheritedActiveTurn) {
      // Pi may replace this extension runtime while the model is still
      // streaming. Adopt the durable turn marker before probing pending
      // completion blocks so the replacement does not submit a duplicate
      // follow-up while the original turn is still active.
      activeTurnId = inheritedActiveTurn.turn_id;
      agentTurnActive = true;
      persistActiveTurn(
        projectCwd,
        currentSessionId,
        currentRuntimeId,
        activeTurnId,
        inheritedActiveTurn.started_at,
        process.pid,
        processIncarnation(process.pid),
        adapter,
      );
    } else {
      activeTurnId = undefined;
      agentTurnActive = false;
    }
    const pendingSummary = readPendingSummary(projectCwd, currentSessionId, adapter);
    if (pendingSummary) latestSummary = pendingSummary;
    if (
      pendingSummary &&
      safePiCall("replay final session summary", () =>
        pi.appendEntry("agent-pi-harness-final-session-summary", { summary: pendingSummary }),
      )
    ) {
      rmSync(pendingSummaryPath(projectCwd, currentSessionId, adapter), { force: true });
      writeFileSync(deliveredSummaryPath(projectCwd, currentSessionId, adapter), `${pendingSummary}\n`, { mode: 0o600 });
    }
    ctx.ui.setStatus("harness-links", ctx.ui.theme.fg("accent", buildOperatorStatus(projectCwd)));
    await safePiAsyncCall("initial operator status", () =>
      refreshOperatorStatus(pi, ctx, projectCwd, adapter),
    );
    await handlers.onSessionStart(projectCwd, {
      session_id: currentSessionId,
      cwd: projectCwd,
    });
    const pendingBlock = readSessionPendingBlock(
      projectCwd,
      currentSessionId,
      replayBranchName,
      adapter,
    );
    await safePiAsyncCall("session tab color", () =>
      setTabColor(
        pi,
        projectCwd,
        tabColorForPendingReplay(Boolean(pendingBlock)),
        adapter,
      ),
    );
    replayPendingBlockOnce();
    // A durable, greppable marker lets project smoke checks prove this
    // extension actually loaded and ran. This
    // call is on the OTHER side of the `await` above from the SessionStart
    // dispatch to python — the exact window a drive-run reproduced the
    // stale-runtime throw in (see `safePiCall`) — so it needs the same guard.
    safePiCall("session_start agent-pi-harness-smoke marker", () =>
      pi.appendEntry("agent-pi-harness-smoke", { extension: "agent-pi-harness-lifecycle" }),
    );
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    stopPendingBlockReplayPoll();
    awaitingBlockDelivery = undefined;
    awaitingBlockDeliveries = [];
    const sessionId = resolveSessionId(ctx, adapter);
    await handlers.onSessionShutdown(projectCwd, {
      session_id: sessionId,
      cwd: projectCwd,
      reason: event.reason,
    });
    if (event.reason === "quit") {
      let deliveredSummary: string | undefined;
      try {
        deliveredSummary = readFileSync(deliveredSummaryPath(projectCwd, currentSessionId, adapter), "utf8").trim() || undefined;
      } catch {}
      if (deliveredSummary === latestSummary) return;
      persistPendingSummary(projectCwd, currentSessionId, latestSummary, adapter);
      if (safePiCall("final session summary", () =>
        pi.appendEntry("agent-pi-harness-final-session-summary", { summary: latestSummary }),
      )) {
        rmSync(pendingSummaryPath(projectCwd, currentSessionId, adapter), { force: true });
        writeFileSync(deliveredSummaryPath(projectCwd, currentSessionId, adapter), `${latestSummary}\n`, { mode: 0o600 });
      }
      if (process.stderr.isTTY) ctx.ui.notify(`Session summary\n\n${latestSummary}`, "info");
    }
  });

  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (activeTurnId) {
      clearActiveTurn(projectCwd, currentSessionId, currentRuntimeId, activeTurnId, adapter);
    }
    activeTurnId = undefined;
    agentTurnActive = readActiveTurn(projectCwd, currentSessionId, adapter) !== undefined;
    latestSummary = finalAssistantSummary(event.messages);
    persistPendingSummary(projectCwd, currentSessionId, latestSummary, adapter);
    latestAgentRunNeedsAttention = agentRunNeedsAttention(event.messages);
    if (awaitingBlockDelivery) schedulePendingBlockReplayPoll();
  });

  pi.on("agent_start", async (_event: AgentStartEvent) => {
    const tabColorUpdated = await safePiAsyncCall("agent start tab color", () =>
      setTabColor(
        pi,
        projectCwd,
        tabColorForAgentStart(handlers.stopDispatchFailureCount() > 0),
        adapter,
      ),
    );
    if (!tabColorUpdated) return;
    refreshReplayBranchName();
    activeTurnId = randomUUID();
    agentTurnActive = true;
    persistActiveTurn(
      projectCwd,
      currentSessionId,
      currentRuntimeId,
      activeTurnId,
      Date.now(),
      process.pid,
      processIncarnation(process.pid),
      adapter,
    );
  });

  function acknowledgeAwaitingBlock(prompt: string): void {
    const consumed = consumePendingBlockDelivery(awaitingBlockDeliveries, prompt);
    const pending = consumed.block;
    if (!pending) return;
    awaitingBlockDeliveries = consumed.remaining;
    awaitingBlockDelivery = awaitingBlockDeliveries.at(-1);
    removePendingBlockDelivery(projectCwd, currentSessionId, pending.dispatch_id, adapter);
    const current = readSessionPendingBlock(projectCwd, currentSessionId, null, adapter);
    acknowledgePendingBlock(
      projectCwd,
      currentSessionId,
      currentRuntimeId,
      pending.dispatch_id,
      renameSync,
      adapter,
    );
    if (current?.dispatch_id === pending.dispatch_id &&
      readSessionPendingBlock(projectCwd, currentSessionId, null, adapter) === undefined) {
      awaitingBlockDelivery = awaitingBlockDeliveries.at(-1);
      pendingBlockDeliveryRetryAt = 0;
      stopPendingBlockReplayPoll();
      // Acknowledging one replay must not end the bounded orphan-recovery
      // window: a replacement launcher can inherit several dead sessions'
      // completion blocks. Restart the poll so the next eligible block is
      // claimed after the normal orphan-recovery interval.
      resetPendingBlockReplayWindow();
      schedulePendingBlockReplayPoll();
    }
  }

  pi.on("message_start", (event: MessageStartEvent) => {
    refreshReplayBranchName();
    const prompt = userMessageText(event.message);
    if (prompt) acknowledgeAwaitingBlock(prompt);
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    await handlers.onToolResult(
      projectCwd,
      buildToolResultPayload(
        event,
        projectCwd,
        resolveSessionId(ctx, adapter),
        resolveModelContext(projectCwd, ctx, adapter),
      ),
    );
    if (shouldRefreshOperatorStatus(event)) {
      await safePiAsyncCall(
        "operator status refresh",
        () => refreshOperatorStatus(pi, ctx, projectCwd, adapter),
      );
    }
  });

  pi.on("input", async (event: InputEvent) => {
    // Pi emits input before validating model/authentication and before
    // agent_start. Leave the prior ready/needs-input state visible until the
    // agent_start event proves that work actually began.
    await handlers.onInput(projectCwd, {
      cwd: projectCwd,
      session_id: currentSessionId,
      prompt: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    });
    return undefined;
  });

  pi.on("agent_settled", async (_event: AgentSettledEvent) => {
    const settledOutcome = await handlers.onAgentSettled(projectCwd, {
      cwd: projectCwd,
      session_id: currentSessionId,
      dispatch_id: randomUUID(),
    });
    const outcome: AgentSettledOutcome =
      settledOutcome === "completed" && latestAgentRunNeedsAttention ? "agent_failed" : settledOutcome;
    latestAgentRunNeedsAttention = false;
    await safePiAsyncCall("settled tab color", () =>
      setTabColor(
        pi,
        projectCwd,
        tabColorAfterAgentSettled(outcome),
        adapter,
      ),
    );
  });
}

/**
 * Pi-compatible package entry point. Loading the package directly is inert;
 * a project shim activates policy only by supplying its validated adapter.
 */
export default function lifecycle(
  pi: ExtensionAPI,
  adapter?: ProjectAdapterV1,
): void {
  if (adapter === undefined) return;
  registerLifecycle(pi, adapter);
}
