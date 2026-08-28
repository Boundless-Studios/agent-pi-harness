import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOperatorStatus,
  buildToolResultPayload,
  claimOrphanedPendingBlock,
  consumePendingBlockDelivery,
  createLifecycleHandlers as createLifecycleHandlersBase,
  createPendingCompletionBlock,
  clearActiveTurn as clearActiveTurnBase,
  finalAssistantSummary,
  markPendingBlockDelivered as markPendingBlockDeliveredBase,
  PENDING_BLOCK_REPLAY_MAX_ATTEMPTS,
  PENDING_BLOCK_ORPHAN_RECOVERY_INTERVAL_MS,
  processIncarnation,
  persistLifecycleBudget as persistLifecycleBudgetBase,
  persistActiveTurn as persistActiveTurnBase,
  persistPendingBlock as persistPendingBlockBase,
  readLifecycleBudget as readLifecycleBudgetBase,
  readActiveTurn as readActiveTurnBase,
  readPendingBlock as readPendingBlockBase,
  readOrphanedPendingBlock as readOrphanedPendingBlockBase,
  acknowledgePendingBlock as acknowledgePendingBlockBase,
  acknowledgePendingBlockForPrompt as acknowledgePendingBlockForPromptBase,
  replayPendingCompletionBlock as replayPendingCompletionBlockBase,
  resetPendingBlockReplayState,
  shouldAttemptPendingBlockReplay,
  shouldRetryPendingBlockDelivery,
  scopePendingBlockToBranch,
  userMessageText,
  isStaleRuntimeError,
  REENGAGE_LIMIT,
  safePiCall,
  shouldRefreshOperatorStatus,
  STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD,
  agentRunNeedsAttention,
  tabColorAfterAgentSettled,
  tabColorForAgentStart,
  tabColorForPendingReplay,
  tabColorForState,
  toolResponseFromEvent,
} from "../src/lifecycle.js";
import type { AgentSettledOutcome, DispatchResult } from "../src/lifecycle.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { GAIA_FIXTURE_ADAPTER } from "./fixtures/gaia-adapter.js";

function stubDispatchResult(overrides: Partial<DispatchResult>): DispatchResult {
  return {
    results: [],
    block: false,
    block_reason: "",
    torn_down: [],
    teardown_warnings: [],
    ...overrides,
  };
}

function noopAppendEntry(): void {}

function withGaiaAdapter<T extends (...args: any[]) => any>(fn: T, adapterIndex: number): T {
  const call = fn as (...args: any[]) => ReturnType<T>;
  return ((...args: Parameters<T>) => {
    const callArgs = [...args] as any[];
    while (callArgs.length < adapterIndex) callArgs.push(undefined);
    callArgs[adapterIndex] = GAIA_FIXTURE_ADAPTER;
    return call(...callArgs);
  }) as T;
}

const createLifecycleHandlers = (deps: Parameters<typeof createLifecycleHandlersBase>[0]) =>
  createLifecycleHandlersBase({ ...deps, adapter: GAIA_FIXTURE_ADAPTER });
const clearActiveTurn = withGaiaAdapter(clearActiveTurnBase, 4);
const markPendingBlockDelivered = withGaiaAdapter(markPendingBlockDeliveredBase, 4);
const persistLifecycleBudget = withGaiaAdapter(persistLifecycleBudgetBase, 4);
const persistActiveTurn = withGaiaAdapter(persistActiveTurnBase, 7);
const persistPendingBlock = withGaiaAdapter(persistPendingBlockBase, 8);
const readLifecycleBudget = withGaiaAdapter(readLifecycleBudgetBase, 2);
const readActiveTurn = withGaiaAdapter(readActiveTurnBase, 2);
const readPendingBlock = withGaiaAdapter(readPendingBlockBase, 3);
const readOrphanedPendingBlock = withGaiaAdapter(readOrphanedPendingBlockBase, 3);
const acknowledgePendingBlock = withGaiaAdapter(acknowledgePendingBlockBase, 5);
const acknowledgePendingBlockForPrompt = withGaiaAdapter(acknowledgePendingBlockForPromptBase, 5);
const replayPendingCompletionBlock = withGaiaAdapter(replayPendingCompletionBlockBase, 5);

test("gaia-lifecycle: tab states reuse the established iTerm color convention", () => {
  assert.deepEqual(
    (["ready", "working", "done", "needs_input"] as const).map(tabColorForState),
    ["blue", "yellow", "green", "red"],
  );
});

test("gaia-lifecycle: settled tab color distinguishes completion, re-engagement, and failure", () => {
  assert.equal(tabColorAfterAgentSettled("completed"), "green");
  assert.equal(tabColorAfterAgentSettled("reengaged"), "red");
  assert.equal(tabColorAfterAgentSettled("blocked"), "red");
  assert.equal(tabColorAfterAgentSettled("dispatch_failed"), "red");
  assert.equal(tabColorAfterAgentSettled("agent_failed"), "red");
});

test("gaia-lifecycle: replay and dispatch failure stay red until work starts", () => {
  assert.equal(tabColorForPendingReplay(true), "red");
  assert.equal(tabColorForPendingReplay(false), "blue");
  assert.equal(tabColorForAgentStart(true), "red");
  assert.equal(tabColorForAgentStart(false), "yellow");
});

test("gaia-lifecycle: errored or aborted agent runs require operator input", () => {
  assert.equal(agentRunNeedsAttention([{ role: "assistant", stopReason: "error" }]), true);
  assert.equal(agentRunNeedsAttention([{ role: "assistant", stopReason: "aborted" }]), true);
  assert.equal(agentRunNeedsAttention([{ role: "assistant", stopReason: "length" }]), true);
  assert.equal(agentRunNeedsAttention([{ role: "assistant", stopReason: "stop" }]), false);
  assert.equal(agentRunNeedsAttention([{ role: "user", stopReason: "error" }]), false);
});

test("gaia-lifecycle: recovered intermediate length stops do not fail the final run", () => {
  assert.equal(
    agentRunNeedsAttention([
      { role: "assistant", stopReason: "length", toolCall: "reengage" },
      { role: "tool", content: "result" },
      { role: "assistant", stopReason: "stop" },
    ]),
    false,
  );
});

test("gaia-lifecycle: operator status always links the worktree and optional PR", () => {
  assert.equal(
    buildOperatorStatus("/tmp/pi-improvements"),
    "worktree: file:///tmp/pi-improvements",
  );
  assert.equal(
    buildOperatorStatus(
      "/tmp/pi-improvements",
      "https://github.com/Boundless-Studios/gaia-free/pull/99",
    ),
    "worktree: file:///tmp/pi-improvements  PR: https://github.com/Boundless-Studios/gaia-free/pull/99",
  );
});

test("gaia-lifecycle: final summary uses the last assistant text", () => {
  assert.equal(
    finalAssistantSummary([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: [{ type: "text", text: "finished and linked the PR" }] },
    ]),
    "finished and linked the PR",
  );
  assert.match(finalAssistantSummary([]), /without an assistant-authored summary/);
});

test("gaia-lifecycle: pending completion block survives and clears only on matching ack", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/1", "settle CI");
  const pending = readPendingBlock(cwd, "session/1");
  assert.equal(pending?.message, "settle CI");

  acknowledgePendingBlock(cwd, "session/1", "runtime/1", "stale message");
  assert.equal(readPendingBlock(cwd, "session/1")?.message, "settle CI");

  assert.ok(pending);
  acknowledgePendingBlock(cwd, "session/1", "runtime/1", pending.dispatch_id);
  assert.equal(readPendingBlock(cwd, "session/1"), undefined);
});

test("gaia-lifecycle: acknowledgement preserves a replacement dispatch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/ack-race";
  persistPendingBlock(cwd, sessionId, "acknowledge first", "dispatch-first");

  acknowledgePendingBlock(
    cwd,
    sessionId,
    "runtime/1",
    "dispatch-first",
    (source, destination) => {
      renameSync(source, destination);
      persistPendingBlock(cwd, sessionId, "keep replacement", "dispatch-replacement");
    },
  );

  assert.equal(readPendingBlock(cwd, sessionId)?.dispatch_id, "dispatch-replacement");
});

test("gaia-lifecycle: replay ack requires the matching user prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/1", "settle CI", "dispatch-1");
  const pending = readPendingBlock(cwd, "session/1");
  assert.ok(pending);

  assert.equal(
    acknowledgePendingBlockForPrompt(cwd, "session/1", "runtime/1", pending, "unrelated prompt"),
    false,
  );
  assert.equal(readPendingBlock(cwd, "session/1")?.message, "settle CI");

  assert.equal(
    acknowledgePendingBlockForPrompt(cwd, "session/1", "runtime/1", pending, pending.message),
    true,
  );
  assert.equal(readPendingBlock(cwd, "session/1"), undefined);
});

test("gaia-lifecycle: matching prompts consume the oldest dispatch identity", () => {
  const older = createPendingCompletionBlock(
    "session/ack-order",
    "same completion prompt",
    "dispatch-older",
  );
  const newer = createPendingCompletionBlock(
    "session/ack-order",
    "same completion prompt",
    "dispatch-newer",
  );

  const consumed = consumePendingBlockDelivery([older, newer], older.message);

  assert.equal(consumed.block?.dispatch_id, "dispatch-older");
  assert.deepEqual(consumed.remaining.map((block) => block.dispatch_id), ["dispatch-newer"]);
});

test("gaia-lifecycle: delivery identities survive a runtime replacement", async () => {
  const lifecycle = await import("../src/lifecycle.js") as typeof import("../src/lifecycle.js") & {
    persistPendingBlockDelivery?: (
      cwd: string,
      sessionId: string,
      block: ReturnType<typeof createPendingCompletionBlock>,
      adapter?: typeof GAIA_FIXTURE_ADAPTER,
    ) => void;
    readPendingBlockDeliveries?: (
      cwd: string,
      sessionId: string,
      adapter?: typeof GAIA_FIXTURE_ADAPTER,
    ) => ReturnType<typeof createPendingCompletionBlock>[];
  };
  assert.equal(typeof lifecycle.persistPendingBlockDelivery, "function");
  assert.equal(typeof lifecycle.readPendingBlockDeliveries, "function");
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/durable-delivery-queue";
  const older = createPendingCompletionBlock(sessionId, "same prompt", "dispatch-older");
  const newer = createPendingCompletionBlock(sessionId, "same prompt", "dispatch-newer");

  lifecycle.persistPendingBlockDelivery!(cwd, sessionId, older, GAIA_FIXTURE_ADAPTER);
  lifecycle.persistPendingBlockDelivery!(cwd, sessionId, newer, GAIA_FIXTURE_ADAPTER);

  assert.deepEqual(
    lifecycle.readPendingBlockDeliveries!(cwd, sessionId, GAIA_FIXTURE_ADAPTER).map(
      (block) => block.dispatch_id,
    ),
    ["dispatch-older", "dispatch-newer"],
  );
});

test("gaia-lifecycle: queued delivery identities retain their branch scope", () => {
  const block = createPendingCompletionBlock("session/branch-delivery", "same prompt", "dispatch-branch");
  const scoped = scopePendingBlockToBranch(block, "feature/replay");

  assert.equal(scoped.branch_name, "feature/replay");
  assert.equal(
    scopePendingBlockToBranch({ ...block, branch_name: "original" }, "feature/replay").branch_name,
    "original",
  );
});

test("gaia-lifecycle: concurrent sessions keep independent pending completion blocks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/1", "settle first PR");
  persistPendingBlock(cwd, "session/2", "settle second PR");

  assert.equal(readPendingBlock(cwd, "session/1")?.message, "settle first PR");
  assert.equal(readPendingBlock(cwd, "session/2")?.message, "settle second PR");

  const first = readPendingBlock(cwd, "session/1");
  assert.ok(first);
  acknowledgePendingBlock(cwd, "session/1", "runtime/1", first.dispatch_id);
  assert.equal(readPendingBlock(cwd, "session/1"), undefined);
  assert.equal(readPendingBlock(cwd, "session/2")?.message, "settle second PR");
});

test("gaia-lifecycle: a session atomically claims a legacy pending completion block", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const legacyDirectory = join(cwd, ".gaia", "pi-finalization");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    join(legacyDirectory, "unclaimed-block.json"),
    `${JSON.stringify({ schema_version: 1, message: "settle legacy PR" })}\n`,
  );

  assert.equal(readPendingBlock(cwd, "session/new")?.message, "settle legacy PR");
  assert.equal(readPendingBlock(cwd, "session/other"), undefined);
});

test("gaia-lifecycle: a claimed legacy block is persisted with recoverable ownership", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const legacyDirectory = join(cwd, ".gaia", "pi-finalization");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    join(legacyDirectory, "unclaimed-block.json"),
    `${JSON.stringify({ schema_version: 1, message: "recover legacy PR" })}\n`,
  );

  assert.equal(readPendingBlock(cwd, "session/legacy-claim")?.message, "recover legacy PR");
  const claimedPath = join(
    legacyDirectory,
    `pending-block-${createHash("sha256").update("session/legacy-claim").digest("hex")}.json`,
  );
  const claimed = JSON.parse(readFileSync(claimedPath, "utf8")) as Record<string, unknown>;
  assert.equal(claimed.schema_version, 2);
  assert.equal(claimed.kind, "completion-block");
  assert.equal(claimed.session_id, "session/legacy-claim");
  assert.equal(typeof claimed.owner_pid, "number");

  writeFileSync(
    claimedPath,
    `${JSON.stringify({ ...claimed, owner_pid: 2147483647, owner_process_start: "stale" })}\n`,
  );
  const recovered = readOrphanedPendingBlock(cwd, "session/legacy-recovery");
  assert.equal(recovered?.message, "recover legacy PR");
  assert.equal(recovered?.session_id, "session/legacy-recovery");
});

test("gaia-lifecycle: a restarted launcher claims an orphaned session block", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(
    cwd,
    "session/before-restart",
    "settle interrupted PR",
    "dispatch-restart",
    2147483647,
  );

  const claimed = readOrphanedPendingBlock(cwd, "session/after-restart");
  assert.equal(claimed?.message, "settle interrupted PR");
  assert.equal(claimed?.session_id, "session/after-restart");
  assert.equal(claimed?.owner_pid, process.pid);
  assert.equal(readOrphanedPendingBlock(cwd, "session/second-restart"), undefined);
  assert.equal(readPendingBlock(cwd, "session/before-restart"), undefined);
});

test("gaia-lifecycle: orphan recovery transfers the dead session budget", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const orphanSession = "session/with-budget";
  persistLifecycleBudget(cwd, orphanSession, 3, 2);
  persistPendingBlock(cwd, orphanSession, "settle interrupted PR", "dispatch-budget", 2147483647);

  const claimed = readOrphanedPendingBlock(cwd, "session/replacement");
  assert.equal(claimed?.session_id, "session/replacement");
  assert.equal(readLifecycleBudget(cwd, "session/replacement")?.reengage_count, 3);
  assert.equal(readLifecycleBudget(cwd, "session/replacement")?.stop_dispatch_failure_count, 2);
});

test("gaia-lifecycle: lifecycle budgets reset when a worktree changes branches", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "first"], { cwd });
  const sessionId = "session/branch-budget";
  persistLifecycleBudget(cwd, sessionId, 5, 4);
  execFileSync("git", ["branch", "-m", "second"], { cwd });

  assert.equal(readLifecycleBudget(cwd, sessionId), undefined);
  persistLifecycleBudget(cwd, sessionId, 1, 0);
  assert.equal(readLifecycleBudget(cwd, sessionId)?.branch_name, "second");
  assert.equal(readLifecycleBudget(cwd, sessionId)?.reengage_count, 1);
});

test("gaia-lifecycle: orphan recovery records the new budget owner before source cleanup", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sourceSession = "session/crashed-source";
  const targetSession = "session/replacement";
  persistLifecycleBudget(cwd, sourceSession, 2, 3);
  persistPendingBlock(cwd, sourceSession, "recover before cleanup", "dispatch-before-cleanup", 2147483647);

  assert.throws(
    () =>
      readOrphanedPendingBlock(cwd, targetSession, {
        beforeBudgetCleanup: () => {
          throw new Error("simulated crash before source cleanup");
        },
      }),
    /simulated crash before source cleanup/,
  );

  const directory = join(cwd, ".gaia", "pi-finalization");
  const stagedName = readdirSync(directory).find((name) => name.includes(".claiming-"));
  assert.ok(stagedName);
  const staged = JSON.parse(readFileSync(join(directory, stagedName), "utf8")) as Record<string, unknown>;
  assert.equal(staged.budget_source_session_id, targetSession);
  assert.equal(readLifecycleBudget(cwd, sourceSession)?.reengage_count, 2);
});

test("gaia-lifecycle: orphan recovery adds independent target and source budgets", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sourceSession = "session/independent-source";
  const targetSession = "session/independent-target";
  persistLifecycleBudget(cwd, sourceSession, 2, 3);
  persistLifecycleBudget(cwd, targetSession, 1, 4);
  persistPendingBlock(cwd, sourceSession, "recover independently budgeted block", "dispatch-independent", 2147483647);

  const claimed = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(claimed?.session_id, targetSession);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.reengage_count, 3);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.stop_dispatch_failure_count, 7);
});

test("gaia-lifecycle: a retried budget transfer is exactly once", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sourceSession = "session/retry-source";
  const targetSession = "session/retry-target";
  const directory = join(cwd, ".gaia", "pi-finalization");
  persistLifecycleBudget(cwd, sourceSession, 2, 3);
  persistLifecycleBudget(cwd, targetSession, 3, 7);
  const targetBudgetPath = join(
    directory,
    `lifecycle-budget-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  writeFileSync(
    targetBudgetPath,
    `${JSON.stringify({
      schema_version: 1,
      session_id: targetSession,
      reengage_count: 3,
      stop_dispatch_failure_count: 7,
      transferred_from_session_ids: [sourceSession],
    })}\n`,
  );
  persistPendingBlock(cwd, sourceSession, "recover retried budget", "dispatch-retry", 2147483647);

  const claimed = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(claimed?.session_id, targetSession);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.reengage_count, 3);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.stop_dispatch_failure_count, 7);
  assert.equal(readLifecycleBudget(cwd, sourceSession), undefined);
});

test("gaia-lifecycle: an unowned schema-v1 session block remains untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  mkdirSync(directory, { recursive: true });
  const legacySession = "session/before-schema-migration";
  const source = join(
    directory,
    `pending-block-${createHash("sha256").update(legacySession).digest("hex")}.json`,
  );
  writeFileSync(source, `${JSON.stringify({ schema_version: 1, message: "migrate me" })}\n`);

  assert.equal(readOrphanedPendingBlock(cwd, "session/after-schema-migration"), undefined);
  assert.equal(readFileSync(source, "utf8").includes("migrate me"), true);
});

test("gaia-lifecycle: orphan recovery distinguishes process incarnations", () => {
  const ownerStart = processIncarnation(process.pid);
  assert.ok(ownerStart);

  const staleCwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(
    staleCwd,
    "session/stale-incarnation",
    "recover stale incarnation",
    "dispatch-stale-incarnation",
    process.pid,
    "stale-incarnation",
  );
  assert.equal(readOrphanedPendingBlock(staleCwd, "session/replacement")?.message, "recover stale incarnation");

  const liveCwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(
    liveCwd,
    "session/live-incarnation",
    "keep live incarnation",
    "dispatch-live-incarnation",
    process.pid,
    ownerStart,
  );
  assert.equal(readOrphanedPendingBlock(liveCwd, "session/replacement"), undefined);
});

test("gaia-lifecycle: a dead orphan claim survives the staging filename", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const orphanSession = "session/staged-orphan";
  persistPendingBlock(cwd, orphanSession, "recover staged block", "dispatch-staged", 2147483647);
  const source = join(
    directory,
    `pending-block-${createHash("sha256").update(orphanSession).digest("hex")}.json`,
  );
  const staging = `${source}.claiming-2147483647`;
  renameSync(source, staging);

  const claimed = readOrphanedPendingBlock(cwd, "session/replacement");
  assert.equal(claimed?.message, "recover staged block");
  assert.equal(claimed?.session_id, "session/replacement");
  const replacementHash = createHash("sha256")
    .update("session/replacement")
    .digest("hex");
  assert.equal(
    readFileSync(join(directory, `pending-block-${replacementHash}.json`), "utf8").includes(
      "recover staged block",
    ),
    true,
  );
});

test("gaia-lifecycle: orphan recovery finds a block stranded in owner-refresh staging", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/refresh-staged-source";
  const targetSession = "session/refresh-staged-target";
  persistPendingBlock(
    cwd,
    sourceSession,
    "recover refresh-staged block",
    "dispatch-refresh-staged",
    2147483647,
    "stale",
  );
  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const stagingPath = `${sourcePath}.refreshing-2147483647-00000000-0000-4000-8000-000000000000`;
  renameSync(sourcePath, stagingPath);

  const recovered = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(recovered?.message, "recover refresh-staged block");
  assert.equal(recovered?.session_id, targetSession);
  assert.equal(readPendingBlock(cwd, sourceSession), undefined);
});

test("gaia-lifecycle: refresh staging preserves the owner's process incarnation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/refresh-incarnation-source";
  const targetSession = "session/refresh-incarnation-target";
  persistPendingBlock(
    cwd,
    sourceSession,
    "recover refresh-incarnation block",
    "dispatch-refresh-incarnation",
    2147483647,
    "stale-owner",
  );
  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const encodedIncarnation = Buffer.from("stale-owner").toString("hex");
  const stagingPath = `${sourcePath}.refreshing-${process.pid}-inc${encodedIncarnation}-00000000-0000-4000-8000-000000000000`;
  renameSync(sourcePath, stagingPath);

  const recovered = readOrphanedPendingBlock(cwd, targetSession);

  assert.equal(recovered?.message, "recover refresh-incarnation block");
  assert.equal(recovered?.session_id, targetSession);
});

test("gaia-lifecycle: refresh staging keeps a live process incarnation untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/live-refresh-incarnation-source";
  persistPendingBlock(
    cwd,
    sourceSession,
    "keep live refresh-incarnation block",
    "dispatch-live-refresh-incarnation",
    2147483647,
    "stale-owner",
  );
  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const incarnation = processIncarnation(process.pid);
  assert.ok(incarnation);
  const encodedIncarnation = Buffer.from(incarnation).toString("hex");
  const stagingPath = `${sourcePath}.refreshing-${process.pid}-inc${encodedIncarnation}-00000000-0000-4000-8000-000000000000`;
  renameSync(sourcePath, stagingPath);

  assert.equal(readOrphanedPendingBlock(cwd, "session/live-refresh-incarnation-target"), undefined);
  assert.equal(readFileSync(stagingPath, "utf8").includes("keep live refresh-incarnation block"), true);
});

test("gaia-lifecycle: orphan claims replace a stale destination without losing the block", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  const directory = join(cwd, ".gaia", "pi-finalization");
  const targetSession = "session/stale-destination-target";
  const sourceSession = "session/stale-destination-source";
  persistPendingBlock(cwd, targetSession, "previous branch block", "dispatch-previous");
  const targetPath = join(
    directory,
    `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  const staleDestination = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>;
  writeFileSync(targetPath, `${JSON.stringify({ ...staleDestination, branch_name: "previous" })}\n`);
  persistPendingBlock(
    cwd,
    sourceSession,
    "current branch block",
    "dispatch-current",
    2147483647,
    "stale",
  );

  const recovered = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(recovered?.dispatch_id, "dispatch-current");
  assert.equal(readPendingBlock(cwd, targetSession)?.branch_name, "current");
});

test("gaia-lifecycle: a competing destination does not make a restored orphan look owned", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  const directory = join(cwd, ".gaia", "pi-finalization");
  const targetSession = "session/competing-destination-target";
  const sourceSession = "session/competing-destination-source";
  persistLifecycleBudget(cwd, sourceSession, 2, 3);
  persistLifecycleBudget(cwd, targetSession, 7, 11);
  persistPendingBlock(
    cwd,
    sourceSession,
    "recover after competing block",
    "dispatch-restored-orphan",
    2147483647,
    "stale",
  );
  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const competing = "current destination wins first";
  const recovered = readOrphanedPendingBlock(cwd, targetSession, {
    beforeBudgetCleanup: () => {
      persistPendingBlock(cwd, targetSession, competing, "dispatch-competing");
    },
  });

  assert.equal(recovered?.dispatch_id, "dispatch-competing");
  const restored = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  assert.equal(restored.owner_pid, 2147483647);
  assert.equal(readLifecycleBudget(cwd, sourceSession)?.reengage_count, 2);
  assert.equal(readLifecycleBudget(cwd, sourceSession)?.stop_dispatch_failure_count, 3);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.reengage_count, 7);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.stop_dispatch_failure_count, 11);
  rmSync(
    join(
      directory,
      `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
    ),
    { force: true },
  );
  assert.equal(readOrphanedPendingBlock(cwd, targetSession)?.dispatch_id, "dispatch-restored-orphan");
});

test("gaia-lifecycle: requeues a live-owned orphan claim after a competing transfer", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/requeue-source";
  const targetSession = "session/requeue-target";
  const sourceDispatchId = "dispatch-requeue-source";
  const competingDispatchId = "dispatch-requeue-competing";
  persistLifecycleBudget(cwd, sourceSession, 2, 3);
  persistPendingBlock(
    cwd,
    sourceSession,
    "requeue after competing transfer",
    sourceDispatchId,
    2147483647,
    "stale",
  );

  const targetPath = join(
    directory,
    `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  const recovered = readOrphanedPendingBlock(cwd, targetSession, {
    afterBudgetTransfer: () => {
      persistPendingBlock(cwd, targetSession, "current target wins", competingDispatchId);
    },
  });

  assert.equal(recovered?.dispatch_id, competingDispatchId);
  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const queued = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
  assert.equal(queued.owner_pid, 2147483647);
  assert.equal(queued.session_id, targetSession);
  assert.equal(queued.budget_source_session_id, targetSession);
  assert.equal(queued.budget_transfer_source_session_id, sourceSession);

  rmSync(targetPath, { force: true });
  const replayed = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(replayed?.dispatch_id, sourceDispatchId);
  assert.equal(replayed?.session_id, targetSession);
});

test("gaia-lifecycle: staged orphan claims finish budget transfer after a restart", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/budget-source";
  const targetSession = "session/budget-target";
  const dispatchId = "dispatch-budget-restart";

  persistLifecycleBudget(cwd, sourceSession, 4, 2);
  persistPendingBlock(cwd, sourceSession, "recover budgeted block", dispatchId, 2147483647, "stale");

  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const targetPath = join(
    directory,
    `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  const staging = `${targetPath}.claiming-2147483647`;
  renameSync(sourcePath, staging);
  writeFileSync(
    staging,
    `${JSON.stringify({
      ...createPendingCompletionBlock(targetSession, "recover budgeted block", dispatchId, 2147483647, "stale"),
      budget_source_session_id: sourceSession,
    })}\n`,
  );

  const claimed = readOrphanedPendingBlock(cwd, targetSession);
  assert.equal(claimed?.session_id, targetSession);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.reengage_count, 4);
  assert.equal(readLifecycleBudget(cwd, targetSession)?.stop_dispatch_failure_count, 2);
  assert.equal(readLifecycleBudget(cwd, sourceSession), undefined);
});

test("gaia-lifecycle: staged orphan claims finish Stop-order transfer after a restart", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/stop-order-staged-source";
  const targetSession = "session/stop-order-staged-target";
  const dispatchId = "dispatch-stop-order-staged";
  const healthyHandlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await healthyHandlers.onAgentSettled(cwd, {
    session_id: sourceSession,
    stop_order: 5,
  });
  persistPendingBlock(
    cwd,
    sourceSession,
    "recover ordered staged block",
    dispatchId,
    2147483647,
    "stale",
    5,
  );

  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const targetPath = join(
    directory,
    `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  const staging = `${targetPath}.claiming-2147483647`;
  renameSync(sourcePath, staging);
  writeFileSync(
    staging,
    `${JSON.stringify({
      ...createPendingCompletionBlock(
        targetSession,
        "recover ordered staged block",
        dispatchId,
        2147483647,
        "stale",
        5,
      ),
      budget_source_session_id: targetSession,
      budget_transfer_source_session_id: sourceSession,
    })}\n`,
  );

  const claimed = readOrphanedPendingBlock(cwd, targetSession);

  assert.equal(claimed?.session_id, targetSession);
  const orderHash = createHash("sha256").update(targetSession).digest("hex");
  const targetOrderPath = join(directory, `stop-order-${orderHash}.json`);
  const targetOrder = JSON.parse(readFileSync(targetOrderPath, "utf8")) as Record<string, unknown>;
  assert.ok((targetOrder.next_order as number) >= 5);
  assert.equal(existsSync(sourcePath), false);
});

test("gaia-lifecycle: failed Stop-order transfer requeues an orphan with dead ownership", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/stop-order-requeue-source";
  const targetSession = "session/stop-order-requeue-target";
  const dispatchId = "dispatch-stop-order-requeue";
  const healthyHandlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await healthyHandlers.onAgentSettled(cwd, {
    session_id: sourceSession,
    stop_order: 7,
  });
  persistPendingBlock(
    cwd,
    sourceSession,
    "requeue ordered staged block",
    dispatchId,
    2147483647,
    "stale",
    7,
  );

  const sourcePath = join(
    directory,
    `pending-block-${createHash("sha256").update(sourceSession).digest("hex")}.json`,
  );
  const targetPath = join(
    directory,
    `pending-block-${createHash("sha256").update(targetSession).digest("hex")}.json`,
  );
  const staging = `${targetPath}.claiming-2147483647`;
  renameSync(sourcePath, staging);
  writeFileSync(
    staging,
    `${JSON.stringify({
      ...createPendingCompletionBlock(
        targetSession,
        "requeue ordered staged block",
        dispatchId,
        2147483647,
        "stale",
        7,
      ),
      budget_source_session_id: targetSession,
      budget_transfer_source_session_id: sourceSession,
    })}\n`,
  );
  const targetOrderHash = createHash("sha256").update(targetSession).digest("hex");
  const targetOrderPath = join(directory, `stop-order-${targetOrderHash}.json`);
  mkdirSync(`${targetOrderPath}.lock`, { recursive: true });
  writeFileSync(
    join(`${targetOrderPath}.lock`, "owner"),
    `${JSON.stringify({
      owner_pid: process.pid,
      owner_process_start: processIncarnation(process.pid),
    })}\n`,
  );

  assert.equal(readOrphanedPendingBlock(cwd, targetSession), undefined);
  const requeued = JSON.parse(readFileSync(staging, "utf8")) as Record<string, unknown>;
  assert.equal(requeued.owner_pid, 2147483647);
  assert.equal(requeued.session_id, targetSession);

  rmSync(`${targetOrderPath}.lock`, { recursive: true, force: true });
  assert.equal(readOrphanedPendingBlock(cwd, targetSession)?.session_id, targetSession);
});

test("gaia-lifecycle: replacement claims transfer from the current owner", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sourceSession = "session/replacement-a";
  const replacementSession = "session/replacement-b";
  const secondReplacementSession = "session/replacement-c";
  const dispatchId = "dispatch-budget-second-hop";

  persistLifecycleBudget(cwd, sourceSession, 4, 2);
  persistPendingBlock(cwd, sourceSession, "recover second-hop budget", dispatchId, 2147483647, "stale");

  const firstClaim = readOrphanedPendingBlock(cwd, replacementSession);
  assert.equal(firstClaim?.session_id, replacementSession);
  assert.equal(readLifecycleBudget(cwd, sourceSession), undefined);

  const replacementPath = join(
    directory,
    `pending-block-${createHash("sha256").update(replacementSession).digest("hex")}.json`,
  );
  const replacement = JSON.parse(readFileSync(replacementPath, "utf8")) as Record<string, unknown>;
  assert.equal(replacement.budget_source_session_id, replacementSession);
  writeFileSync(
    replacementPath,
    `${JSON.stringify({ ...replacement, owner_pid: 2147483647, owner_process_start: "stale" })}\n`,
  );

  const secondClaim = readOrphanedPendingBlock(cwd, secondReplacementSession);
  assert.equal(secondClaim?.session_id, secondReplacementSession);
  assert.equal(readLifecycleBudget(cwd, secondReplacementSession)?.reengage_count, 4);
  assert.equal(readLifecycleBudget(cwd, secondReplacementSession)?.stop_dispatch_failure_count, 2);
  assert.equal(readLifecycleBudget(cwd, replacementSession), undefined);
});

test("gaia-lifecycle: a live schema-v1 claim remains untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const directory = join(cwd, ".gaia", "pi-finalization");
  mkdirSync(directory, { recursive: true });
  const source = join(
    directory,
    `pending-block-${createHash("sha256").update("session/live-v1").digest("hex")}.json`,
  );
  const staging = `${source}.claiming-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify({ schema_version: 1, message: "live" })}\n`);

  assert.equal(readOrphanedPendingBlock(cwd, "session/replacement"), undefined);
  assert.match(readFileSync(staging, "utf8"), /"message":"live"/);
});

test("gaia-lifecycle: orphan source claims are exclusive", () => {
  const source = "/tmp/pending-block-source.json";
  const claimedSources = new Set<string>();
  const atomicRename = (candidate: string, _destination: string): void => {
    if (claimedSources.has(candidate)) throw new Error("source already claimed");
    claimedSources.add(candidate);
  };

  assert.equal(claimOrphanedPendingBlock(source, "/tmp/session-one.json", atomicRename), true);
  assert.equal(claimOrphanedPendingBlock(source, "/tmp/session-two.json", atomicRename), false);
});

test("gaia-lifecycle: orphan recovery leaves a live owner's block untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(
    cwd,
    "session/live",
    "settle the live PR",
    "dispatch-live",
    process.pid,
  );

  assert.equal(readOrphanedPendingBlock(cwd, "session/new"), undefined);
  assert.equal(readPendingBlock(cwd, "session/live")?.message, "settle the live PR");
});

test("gaia-lifecycle: orphan recovery skips blocks from another branch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  persistPendingBlock(
    cwd,
    "session/old-branch",
    "settle the old branch",
    "dispatch-old-branch",
    2147483647,
  );
  const source = join(
    cwd,
    ".gaia",
    "pi-finalization",
    `pending-block-${createHash("sha256").update("session/old-branch").digest("hex")}.json`,
  );
  const block = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  block.branch_name = "previous";
  writeFileSync(source, `${JSON.stringify(block)}\n`);

  assert.equal(readOrphanedPendingBlock(cwd, "session/current"), undefined);
  assert.equal(readFileSync(source, "utf8").includes("settle the old branch"), true);
});

test("gaia-lifecycle: replay never claims another active session's block", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sentMessages: string[] = [];
  persistPendingBlock(cwd, "session/other", "settle the other PR", "dispatch-other");

  assert.equal(
    replayPendingCompletionBlock(cwd, "session/new", "runtime/new", (content) => {
      sentMessages.push(content);
      return true;
    }),
    undefined,
  );
  assert.deepEqual(sentMessages, []);
  assert.equal(readPendingBlock(cwd, "session/other")?.message, "settle the other PR");
});

test("gaia-lifecycle: direct replay rejects a block from another branch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  const sessionId = "session/branch-replay";
  persistPendingBlock(cwd, sessionId, "settle the previous branch", "dispatch-branch");
  const path = join(
    cwd,
    ".gaia",
    "pi-finalization",
    `pending-block-${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  const block = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...block, branch_name: "previous" })}\n`);
  const sentMessages: string[] = [];

  assert.equal(
    replayPendingCompletionBlock(cwd, sessionId, "runtime/current", (content) => {
      sentMessages.push(content);
      return true;
    }),
    undefined,
  );
  assert.deepEqual(sentMessages, []);
});

test("gaia-lifecycle: same-session legacy blocks migrate before branch filtering", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  const sessionId = "session/same-session-legacy";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const path = join(
    directory,
    `pending-block-${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, message: "replay legacy block" })}\n`);
  const sentMessages: string[] = [];

  const replayed = replayPendingCompletionBlock(
    cwd,
    sessionId,
    "runtime/current",
    (content) => {
      sentMessages.push(content);
      return true;
    },
  );

  assert.equal(replayed?.message, "replay legacy block");
  assert.deepEqual(sentMessages, ["replay legacy block"]);
  const migrated = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.branch_name, "current");
});

test("gaia-lifecycle: an older blocked Stop preserves a newer pending block", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/blocked-stop-order";
  const userMessages: string[] = [];
  persistPendingBlock(
    cwd,
    sessionId,
    "newer blocked completion",
    "dispatch-newer-block",
    process.pid,
    undefined,
    5,
  );
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({ block: true, block_reason: "older blocked completion" }),
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 4 });

  assert.deepEqual(userMessages, []);
  assert.equal(readPendingBlock(cwd, sessionId)?.dispatch_id, "dispatch-newer-block");
});

test("gaia-lifecycle: orphan recovery carries Stop ordering into the replacement session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sourceSession = "session/orphan-order-source";
  const targetSession = "session/orphan-order-target";
  const healthyHandlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await healthyHandlers.onAgentSettled(cwd, {
    session_id: sourceSession,
    stop_order: 5,
  });
  persistPendingBlock(
    cwd,
    sourceSession,
    "recover ordered completion",
    "dispatch-ordered-orphan",
    2147483647,
    "stale",
    5,
  );

  assert.equal(readOrphanedPendingBlock(cwd, targetSession)?.session_id, targetSession);
  await healthyHandlers.onAgentSettled(cwd, { session_id: targetSession });

  assert.equal(readPendingBlock(cwd, targetSession), undefined);
});

test("gaia-lifecycle: stale completion delivery leaves a typed replay record for the next runtime", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const message = "pi-completion-gate: open a PR before finishing";

  persistPendingBlock(cwd, "session/old", message);
  assert.equal(
    safePiCall("completion block", () => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
      );
    }),
    false,
  );

  const pending = readPendingBlock(cwd, "session/new", "session/old") as unknown;
  assert.equal(typeof pending, "object");
  const record = pending as Record<string, unknown>;
  assert.equal(record.schema_version, 2);
  assert.equal(record.kind, "completion-block");
  assert.equal(record.session_id, "session/old");
  assert.equal(record.message, message);
  assert.match(String(record.dispatch_id), /^[a-f0-9]{64}$/);
});

test("gaia-lifecycle: an accepted delivery marker is deduped until acknowledgement", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/old", "open a PR", "dispatch-1");
  const pending = readPendingBlock(cwd, "session/new", "session/old");
  assert.ok(pending);

  const delivered = markPendingBlockDelivered(cwd, "session/new", "runtime/new", pending);
  assert.equal(delivered?.delivery_runtime_id, "runtime/new");
  assert.equal(markPendingBlockDelivered(cwd, "session/new", "runtime/new", pending), undefined);

  const replacementDelivered = markPendingBlockDelivered(cwd, "session/new", "runtime/replacement", pending);
  assert.equal(replacementDelivered?.delivery_runtime_id, "runtime/replacement");

  acknowledgePendingBlock(cwd, "session/new", "runtime/replacement", pending.dispatch_id);
  assert.equal(readPendingBlock(cwd, "session/new"), undefined);
});

test("gaia-lifecycle: replay submission stays unmarked until Pi accepts the prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/old", "open a PR", "dispatch-1");
  let sendCount = 0;

  const replayed = replayPendingCompletionBlock(
    cwd,
    "session/new",
    "runtime/new",
    () => {
      sendCount += 1;
      return true;
    },
    "session/old",
  );

  assert.equal(replayed?.delivery_runtime_id, undefined);
  assert.equal(readPendingBlock(cwd, "session/new")?.delivery_runtime_id, undefined);
  assert.equal(
    replayPendingCompletionBlock(cwd, "session/new", "runtime/new", () => {
      sendCount += 1;
      return true;
    })?.message,
    "open a PR",
  );
  assert.equal(sendCount, 2);
});

test("gaia-lifecycle: replacement replay can acknowledge a stale delivery marker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  persistPendingBlock(cwd, "session/replaced", "open a PR", "dispatch-stale-marker");
  const pending = readPendingBlock(cwd, "session/replaced");
  assert.ok(pending);
  assert.ok(markPendingBlockDelivered(cwd, "session/replaced", "runtime/old", pending));

  const replayed = replayPendingCompletionBlock(
    cwd,
    "session/new",
    "runtime/new",
    () => true,
    "session/replaced",
  );
  assert.equal(replayed?.delivery_runtime_id, "runtime/new");
  acknowledgePendingBlock(cwd, "session/new", "runtime/new", "dispatch-stale-marker");
  assert.equal(readPendingBlock(cwd, "session/new"), undefined);
});

test("gaia-lifecycle: replay refreshes ownership before submitting a replacement prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/replay-owner-refresh";
  persistPendingBlock(
    cwd,
    sessionId,
    "resume completion",
    "dispatch-owner-refresh",
    2147483647,
    "stale",
  );

  const replayed = replayPendingCompletionBlock(
    cwd,
    sessionId,
    "runtime/replacement",
    () => true,
  );

  assert.equal(replayed?.owner_pid, process.pid);
  assert.equal(replayed?.owner_process_start, processIncarnation(process.pid));
  assert.equal(readPendingBlock(cwd, sessionId)?.owner_pid, process.pid);
});

test("gaia-lifecycle: an accepted queued replay stays in flight until consumption", () => {
  const pending = createPendingCompletionBlock("session/new", "open a PR", "dispatch-1");

  assert.equal(shouldAttemptPendingBlockReplay(pending, pending, 0, 60_000), false);
  assert.equal(shouldAttemptPendingBlockReplay(pending, undefined, 60_001, 60_000), false);
  assert.equal(shouldAttemptPendingBlockReplay(pending, undefined, 60_001, 60_001), true);
});

test("gaia-lifecycle: replacement runtime inherits active turn and stale runtime cannot clear it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/active-turn";
  const pending = createPendingCompletionBlock(sessionId, "open a PR", "dispatch-1");
  persistActiveTurn(cwd, sessionId, "runtime/old", "turn/old", 10);

  const inherited = readActiveTurn(cwd, sessionId);
  assert.equal(inherited?.runtime_id, "runtime/old");
  assert.equal(
    shouldRetryPendingBlockDelivery(pending, inherited !== undefined, 5_000, 5_000),
    false,
  );

  assert.equal(clearActiveTurn(cwd, sessionId, "runtime/replacement", "turn/replacement"), false);
  assert.equal(readActiveTurn(cwd, sessionId)?.turn_id, "turn/old");

  persistActiveTurn(cwd, sessionId, "runtime/replacement", "turn/replacement", 20);
  assert.equal(clearActiveTurn(cwd, sessionId, "runtime/old", "turn/old"), false);
  assert.equal(readActiveTurn(cwd, sessionId)?.runtime_id, "runtime/replacement");
  assert.equal(clearActiveTurn(cwd, sessionId, "runtime/replacement", "turn/replacement"), true);
  assert.equal(readActiveTurn(cwd, sessionId), undefined);
});

test("gaia-lifecycle: inherited deliveries receive a fresh retry deadline", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const sessionStart = source.slice(
    source.indexOf('pi.on("session_start"'),
    source.indexOf('pi.on("session_shutdown"'),
  );

  const queueLoad = sessionStart.indexOf("awaitingBlockDelivery = awaitingBlockDeliveries.at(-1)");
  const retryInitialization = sessionStart.indexOf("pendingBlockDeliveryRetryAt", queueLoad);
  assert.ok(queueLoad >= 0);
  assert.ok(retryInitialization > queueLoad);
  assert.match(
    sessionStart.slice(retryInitialization, retryInitialization + 180),
    /awaitingBlockDelivery\s*\?\s*Date\.now\(\)\s*\+\s*PENDING_BLOCK_DELIVERY_RETRY_DELAY_MS/,
  );
});

test("gaia-lifecycle: a dead active-turn owner is not adopted by a replacement", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/dead-active-turn";
  persistActiveTurn(cwd, sessionId, "runtime/dead", "turn/dead", 10);
  const markerPath = join(
    cwd,
    ".gaia",
    "pi-finalization",
    `active-turn-${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    markerPath,
    `${JSON.stringify({ ...marker, owner_pid: 2147483647, owner_process_start: "stale" })}\n`,
  );

  assert.equal(readActiveTurn(cwd, sessionId), undefined);
});

test("gaia-lifecycle: a rejected quiet delivery becomes retryable after its grace period", () => {
  const pending = createPendingCompletionBlock("session/new", "open a PR", "dispatch-1");

  assert.equal(shouldRetryPendingBlockDelivery(pending, true, 5_000, 5_000), false);
  assert.equal(shouldRetryPendingBlockDelivery(pending, false, 5_000, 4_999), false);
  assert.equal(shouldRetryPendingBlockDelivery(pending, false, 5_000, 5_000), true);
});

test("gaia-lifecycle: user-message consumption extracts only exact text prompts", () => {
  assert.equal(userMessageText({ role: "assistant", content: "open a PR" }), undefined);
  assert.equal(userMessageText({ role: "user", content: "open a PR" }), "open a PR");
  assert.equal(
    userMessageText({
      role: "user",
      content: [
        { type: "text", text: "open " },
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
        { type: "text", text: "a PR" },
      ],
    }),
    "open a PR",
  );
});

test("gaia-lifecycle: replay probe sees a completion block persisted after session start", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sentMessages: string[] = [];
  const send = (content: string): boolean => {
    sentMessages.push(content);
    return true;
  };

  assert.equal(replayPendingCompletionBlock(cwd, "session/new", "runtime/new", send), undefined);
  persistPendingBlock(cwd, "session/new", "open a PR", "dispatch-1");

  const replayed = replayPendingCompletionBlock(
    cwd,
    "session/new",
    "runtime/new",
    send,
    "session/old",
  );
  assert.equal(replayed?.delivery_runtime_id, undefined);
  assert.deepEqual(sentMessages, ["open a PR"]);
});

test("gaia-lifecycle: replay probe covers the full Stop dispatch dependency budget", () => {
  // Stop hooks allow 15s + 10s + a 5s git_repo probe + 15s, plus margin.
  assert.ok(PENDING_BLOCK_REPLAY_MAX_ATTEMPTS * 100 >= 50_000);
  assert.ok(PENDING_BLOCK_REPLAY_MAX_ATTEMPTS * 100 <= 60_000);
  assert.equal(PENDING_BLOCK_ORPHAN_RECOVERY_INTERVAL_MS, 5_000);
});

test("gaia-lifecycle: delayed orphan recovery starts a fresh replay window", () => {
  const state = resetPendingBlockReplayState(45_000);
  assert.equal(state.attempts, 0);
  assert.equal(state.started_at, 45_000);
  assert.equal(state.last_orphan_recovery_at, 0);
});

test("gaia-lifecycle: a newly persisted block restarts the replay attempt budget", () => {
  assert.deepEqual(resetPendingBlockReplayState(123_456), {
    attempts: 0,
    started_at: 123_456,
    last_orphan_recovery_at: 0,
  });
});

test("gaia-lifecycle: only completion blocks receive durable dispatch identity", async () => {
  const completionBlocks: unknown[] = [];
  const advisoryMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      stubDispatchResult(event === "Stop" ? { block: true, block_reason: "open a PR" } : { block: true, block_reason: "input blocked" }),
    sendUserMessage: (content, completionBlock) => {
      if (completionBlock) completionBlocks.push(completionBlock);
    },
    sendMessage: (content) => {
      advisoryMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {
    session_id: "session/old",
    dispatch_id: "dispatch-1",
    stop_order: 42,
  });
  await handlers.onInput("/tmp/project", {});

  assert.deepEqual(completionBlocks, [
    createPendingCompletionBlock("session/old", "open a PR", "dispatch-1", process.pid, processIncarnation(process.pid), 42),
  ]);
  assert.deepEqual(advisoryMessages, ["input blocked"]);
});

test("gaia-lifecycle: PR status refresh is limited to delivery-changing commands", () => {
  assert.equal(shouldRefreshOperatorStatus(fakeToolResultEvent({ input: { command: "git push" } })), true);
  assert.equal(
    shouldRefreshOperatorStatus(fakeToolResultEvent({ input: { command: "gh pr create --fill" } })),
    true,
  );
  assert.equal(shouldRefreshOperatorStatus(fakeToolResultEvent({ input: { command: "rg TODO" } })), false);
});

/** A minimal stand-in for a Pi `ToolResultEvent` (bash variant) — only the
 * fields `toolResponseFromEvent`/`buildToolResultPayload` read. */
function fakeToolResultEvent(overrides: Partial<{
  input: Record<string, unknown>;
  content: ToolResultEvent["content"];
  isError: boolean;
}> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "bash",
    input: overrides.input ?? { command: "echo hi" },
    content: overrides.content ?? [{ type: "text", text: "hi\n" }],
    isError: overrides.isError ?? false,
    details: undefined,
  };
}

test("gaia-lifecycle: caps re-engage sendUserMessage at 5 blocked agent_settled events", async () => {
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({ block: true, block_reason: "still working" }),
    sendUserMessage: (content) => {
      sentMessages.push(content);
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  const outcomes: AgentSettledOutcome[] = [];
  for (let i = 0; i < 6; i += 1) outcomes.push(await handlers.onAgentSettled("/tmp/project", {}));

  assert.equal(sentMessages.length, REENGAGE_LIMIT);
  assert.equal(handlers.reengageCount(), REENGAGE_LIMIT);
  assert.deepEqual(outcomes, ["reengaged", "reengaged", "reengaged", "reengaged", "reengaged", "blocked"]);
});

test("gaia-lifecycle: red tab color is written before automatic re-engagement", async () => {
  const events: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({ block: true, block_reason: "still working" }),
    beforeReengagement: async () => {
      events.push("red");
    },
    sendUserMessage: () => {
      events.push("send");
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});

  assert.deepEqual(events, ["red", "send"]);
});

test("gaia-lifecycle: session_start resets the re-engage counter", async () => {
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      stubDispatchResult(event === "Stop" ? { block: true, block_reason: "still working" } : {}),
    sendUserMessage: (content) => {
      sentMessages.push(content);
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  for (let i = 0; i < REENGAGE_LIMIT; i += 1) {
    await handlers.onAgentSettled("/tmp/project", {});
  }
  assert.equal(handlers.reengageCount(), REENGAGE_LIMIT);
  assert.equal(sentMessages.length, REENGAGE_LIMIT);

  await handlers.onSessionStart("/tmp/project", {});
  assert.equal(handlers.reengageCount(), 0);

  await handlers.onAgentSettled("/tmp/project", {});
  assert.equal(sentMessages.length, REENGAGE_LIMIT + 1);
});

test("gaia-lifecycle: replacement runtime restores the persisted Stop-failure budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const failing = async () => stubStopDispatchFailure("dispatch.py missing");
  const first = createLifecycleHandlers({
    runDispatch: failing,
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await first.onSessionStart(cwd, { session_id: "session/replacement" });
  await first.onAgentSettled(cwd, { session_id: "session/replacement" });
  assert.equal(first.stopDispatchFailureCount(), 1);
  assert.equal(first.reengageCount(), 1);

  const replacement = createLifecycleHandlers({
    runDispatch: failing,
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });
  await replacement.onSessionStart(cwd, { session_id: "session/replacement" });

  assert.equal(replacement.stopDispatchFailureCount(), 1);
  assert.equal(replacement.reengageCount(), 1);
});

test("gaia-lifecycle: concurrent runtimes accumulate durable budget increments", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const failing = async () => stubStopDispatchFailure("dispatch.py missing");
  const first = createLifecycleHandlers({
    runDispatch: failing,
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });
  const replacement = createLifecycleHandlers({
    runDispatch: failing,
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });
  const payload = { session_id: "session/concurrent" };

  await first.onSessionStart(cwd, payload);
  await replacement.onSessionStart(cwd, payload);
  await first.onAgentSettled(cwd, payload);
  await replacement.onAgentSettled(cwd, payload);

  const budget = readLifecycleBudget(cwd, payload.session_id);
  assert.equal(budget?.reengage_count, 2);
  assert.equal(budget?.stop_dispatch_failure_count, 2);
});

test("gaia-lifecycle: session_shutdown awaits the SessionEnd dispatch before resolving", async () => {
  let dispatchResolved = false;
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) => {
      if (event === "SessionEnd") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        dispatchResolved = true;
      }
      return stubDispatchResult({});
    },
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionShutdown("/tmp/project", {});
  assert.equal(dispatchResolved, true);
});

test("gaia-lifecycle: tool_result surfaces a block reason via sendMessage, never sendUserMessage", async () => {
  const sentMessages: string[] = [];
  const userMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({ block: true, block_reason: "budget exceeded" }),
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onToolResult("/tmp/project", { tool_name: "Bash" });

  assert.deepEqual(sentMessages, ["budget exceeded"]);
  assert.deepEqual(userMessages, []);
});

test("gaia-lifecycle: tool_result surfaces successful advisory stdout via sendMessage", async () => {
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({
        block: false,
        results: [
          { hook: "response-budget-guard.py", decision: "allow", stdout: "" },
          {
            hook: "response-budget-guard.py",
            decision: "allow",
            stdout: '{"tier": "CHECKPOINT", "tokens": 1000}',
          },
        ],
      }),
    sendUserMessage: () => {},
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onToolResult("/tmp/project", { tool_name: "Bash" });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /response-budget-guard\.py/);
  assert.match(sentMessages[0], /CHECKPOINT/);
});

test("gaia-lifecycle: tool_result stays silent when dispatch results carry no advisory output", async () => {
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({
        block: false,
        results: [{ hook: "run_pr_convergence.py", decision: "allow", stdout: "" }],
      }),
    sendUserMessage: () => {},
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onToolResult("/tmp/project", { tool_name: "Bash" });

  assert.deepEqual(sentMessages, []);
});

test("gaia-lifecycle: session_start and session_shutdown surface teardown_warnings via appendEntry", async () => {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      stubDispatchResult({
        teardown_warnings:
          event === "SessionStart"
            ? ["stale owner pid 123 still alive"]
            : ["flock held on .gaia/pi-effects/abc.lock"],
      }),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  });

  await handlers.onSessionStart("/tmp/project", {});
  await handlers.onSessionShutdown("/tmp/project", {});

  assert.equal(appended.length, 2);
  assert.equal(appended[0].customType, "gaia-lifecycle-teardown-warning");
  assert.deepEqual(appended[0].data, {
    source: "SessionStart",
    warnings: ["stale owner pid 123 still alive"],
  });
  assert.deepEqual(appended[1].data, {
    source: "SessionEnd",
    warnings: ["flock held on .gaia/pi-effects/abc.lock"],
  });
});

test("gaia-lifecycle: no appendEntry call when there are no teardown_warnings", async () => {
  const appended: unknown[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: (_customType, data) => {
      appended.push(data);
    },
  });

  await handlers.onSessionStart("/tmp/project", {});
  await handlers.onSessionShutdown("/tmp/project", {});

  assert.deepEqual(appended, []);
});

// ── Stop dispatch fail-closed + bounded release (PR 3535 review round 2 P1 finding B) ──

function stubStopDispatchFailure(message: string): DispatchResult {
  return stubDispatchResult({ teardown_warnings: [message] });
}

test("gaia-lifecycle: a Stop dispatch failure re-engages twice then releases on the third", async () => {
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubStopDispatchFailure("dispatch.py exited 1: boom"),
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  for (let i = 0; i < STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD; i += 1) {
    await handlers.onAgentSettled("/tmp/project", {});
  }

  assert.equal(userMessages.length, STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD - 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /released after 3 consecutive failures/);
  assert.equal(handlers.stopDispatchFailureCount(), STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD);
});

test("gaia-lifecycle: Stop dispatch failures count against the shared REENGAGE_LIMIT cap", async () => {
  const userMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubStopDispatchFailure("dispatch.py missing"),
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  for (let i = 0; i < STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD; i += 1) {
    await handlers.onAgentSettled("/tmp/project", {});
  }
  assert.equal(handlers.reengageCount(), STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD - 1);
});

test("gaia-lifecycle: a healthy Stop dispatch resets the failure counter", async () => {
  let failing = true;
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      failing ? stubStopDispatchFailure("dispatch.py exited 1") : stubDispatchResult({}),
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onAgentSettled("/tmp/project", {});
  assert.equal(handlers.stopDispatchFailureCount(), 2);

  failing = false;
  await handlers.onAgentSettled("/tmp/project", {});
  assert.equal(handlers.stopDispatchFailureCount(), 0);

  failing = true;
  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onAgentSettled("/tmp/project", {});
  // Two more failures after the reset — still below threshold, so no
  // release message has been sent yet.
  assert.equal(sentMessages.length, 0);
  assert.equal(handlers.stopDispatchFailureCount(), 2);
});

test("gaia-lifecycle: bounded Stop-failure release retires its pending prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/stop-failure-release";
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubStopDispatchFailure("dispatch.py exited 1: boom"),
    sendUserMessage: (_content, completionBlock) => {
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  for (let attempt = 0; attempt < STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD; attempt += 1) {
    await handlers.onAgentSettled(cwd, { session_id: sessionId });
  }

  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

test("gaia-lifecycle: Stop-order allocation failures use bounded fail-closed release", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/stop-order-allocation-failure";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const stopOrderHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${stopOrderHash}.json`);
  mkdirSync(stopOrderPath, { recursive: true });
  mkdirSync(`${stopOrderPath}.fallback`);
  writeFileSync(
    `${stopOrderPath}.lock`,
    `${JSON.stringify({
      owner_pid: process.pid,
      owner_process_start: processIncarnation(process.pid),
    })}\n`,
  );
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => {
      throw new Error("Stop dispatch must not run without an order");
    },
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  for (let attempt = 0; attempt < STOP_DISPATCH_FAILURE_RELEASE_THRESHOLD; attempt += 1) {
    const outcome = await handlers.onAgentSettled(cwd, { session_id: sessionId });
    assert.equal(outcome, "dispatch_failed");
  }

  assert.equal(userMessages.length, REENGAGE_LIMIT > 0 ? 2 : 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Stop dispatch released after/);
  assert.equal(readPendingBlock(cwd, sessionId), undefined);
  rmSync(`${stopOrderPath}.lock`, { force: true });
  rmSync(stopOrderPath, { recursive: true, force: true });
  rmSync(`${stopOrderPath}.fallback`, { recursive: true, force: true });
});

test("gaia-lifecycle: a fallback Stop order is persisted before blocking", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/fallback-stop-order";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const stopOrderHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${stopOrderHash}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${stopOrderPath}.lock`,
    `${JSON.stringify({
      owner_pid: process.pid,
      owner_process_start: processIncarnation(process.pid),
    })}\n`,
  );

  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({ block: true, block_reason: "open a PR" }),
    sendUserMessage: (_content, completionBlock) => {
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled(cwd, { session_id: sessionId });

  const pending = readPendingBlock(cwd, sessionId);
  assert.ok(pending?.stop_order !== undefined);
  const fallbackStatePath = `${stopOrderPath}.fallback`;
  assert.equal(existsSync(stopOrderPath), false);
  const orderState = JSON.parse(readFileSync(fallbackStatePath, "utf8")) as Record<string, unknown>;
  assert.ok(typeof orderState.next_order === "number");
  assert.ok(orderState.next_order >= pending.stop_order);
  rmSync(`${stopOrderPath}.lock`, { force: true });
});

test("gaia-lifecycle: a Stop allocation retains a concurrent fallback high-water mark", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/fallback-high-water-mark";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const stopOrderHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${stopOrderHash}.json`);
  const fallbackPath = `${stopOrderPath}.fallback`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    fallbackPath,
    `${JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      next_order: 100,
    })}\n`,
  );
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled(cwd, { session_id: sessionId });

  const orderState = JSON.parse(readFileSync(stopOrderPath, "utf8")) as Record<string, unknown>;
  assert.equal(orderState.next_order, 101);
  assert.equal(existsSync(fallbackPath), true);
});

test("gaia-lifecycle: a healthy Stop fails closed when its order cannot be recorded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/healthy-order-lock-timeout";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const stopOrderHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${stopOrderHash}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${stopOrderPath}.lock`,
    `${JSON.stringify({
      owner_pid: process.pid,
      owner_process_start: processIncarnation(process.pid),
    })}\n`,
  );
  // Force both the lock-guarded primary write and the fallback sidecar write
  // to be unavailable. A healthy Stop must not be reported as completed when
  // its ordering high-water mark cannot be made durable.
  mkdirSync(`${stopOrderPath}.fallback`);
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  const outcome = await handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });

  assert.equal(outcome, "dispatch_failed");
  assert.deepEqual(sentMessages, []);
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0], /Stop dispatch failed/);
  assert.equal(readPendingBlock(cwd, sessionId)?.stop_order, 1);
  rmSync(`${stopOrderPath}.lock`, { force: true });
  rmSync(`${stopOrderPath}.fallback`, { recursive: true, force: true });
});

test("gaia-lifecycle: interactive input clears stale Stop-dispatch failure state", async () => {
  let stopDispatchFailing = true;
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      event === "Stop" && stopDispatchFailing
        ? stubStopDispatchFailure("dispatch.py exited 1")
        : stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onAgentSettled("/tmp/project", {});
  assert.equal(handlers.stopDispatchFailureCount(), 2);

  await handlers.onInput("/tmp/project", { prompt: "continue" });

  assert.equal(handlers.stopDispatchFailureCount(), 0);
  stopDispatchFailing = false;
});

test("gaia-lifecycle: interactive input persists the Stop-failure reset", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "current"], { cwd });
  const sessionId = "session/persisted-input-reset";
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      event === "Stop"
        ? stubStopDispatchFailure("dispatch.py exited 1")
        : stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, { session_id: sessionId });
  assert.equal(readLifecycleBudget(cwd, sessionId)?.stop_dispatch_failure_count, 2);

  await handlers.onInput(cwd, { session_id: sessionId, prompt: "continue" });

  const reset = readLifecycleBudget(cwd, sessionId);
  assert.equal(reset?.stop_dispatch_failure_count, 0);
  assert.equal(reset?.latest_stop_dispatch_failure_order, 2);
  await handlers.onAgentSettled(cwd, { session_id: sessionId });
  assert.deepEqual(sentMessages, []);
  assert.equal(handlers.stopDispatchFailureCount(), 1);
});

test("gaia-lifecycle: completed Stop settlement reclaims per-launch ordering state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/cleanup-completed-state";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${sessionHash}.json`);
  const budgetPath = join(directory, `lifecycle-budget-${sessionHash}.json`);
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, { session_id: sessionId });
  await handlers.onSessionShutdown(cwd, { session_id: sessionId, reason: "quit" });

  assert.equal(existsSync(stopOrderPath), false);
  assert.equal(existsSync(budgetPath), false);
});

test("gaia-lifecycle: non-terminal session replacement preserves lifecycle state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/reload-preserves-state";
  const directory = join(cwd, ".gaia", "pi-finalization");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const stopOrderPath = join(directory, `stop-order-${sessionHash}.json`);
  const budgetPath = join(directory, `lifecycle-budget-${sessionHash}.json`);
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  await handlers.onSessionShutdown(cwd, { session_id: sessionId, reason: "reload" });

  assert.equal(existsSync(stopOrderPath), true);
  assert.equal(existsSync(budgetPath), true);
  await handlers.onSessionShutdown(cwd, { session_id: sessionId, reason: "quit" });
  assert.equal(existsSync(stopOrderPath), false);
  assert.equal(existsSync(budgetPath), false);
});

test("gaia-lifecycle: prompt acknowledgement preserves lifecycle budgets", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const acknowledgementStart = source.indexOf("function acknowledgeAwaitingBlock");
  const messageStart = source.indexOf('pi.on("message_start"', acknowledgementStart);
  assert.ok(acknowledgementStart >= 0);
  assert.ok(messageStart > acknowledgementStart);
  assert.doesNotMatch(
    source.slice(acknowledgementStart, messageStart),
    /cleanupCompletedLifecycleState\(/,
  );
});

test("gaia-lifecycle: an older Stop failure is ignored after a newer healthy Stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/stale-stop-failure";
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  let resolveOlder: ((result: DispatchResult) => void) | undefined;
  let resolveNewer: ((result: DispatchResult) => void) | undefined;
  const handlers = createLifecycleHandlers({
    runDispatch: async (event, _cwd, payload) => {
      if (event === "SessionStart") return stubDispatchResult({});
      return new Promise<DispatchResult>((resolve) => {
        if (payload.stop_order === 1) resolveOlder = resolve;
        else resolveNewer = resolve;
      });
    },
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  const olderFailure = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  const newerHealthy = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  resolveNewer?.(stubDispatchResult({}));
  await newerHealthy;
  resolveOlder?.(stubStopDispatchFailure("dispatch.py exited 1: stale"));
  await olderFailure;

  assert.deepEqual(userMessages, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(handlers.stopDispatchFailureCount(), 0);
  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

test("gaia-lifecycle: an older Stop failure preserves a newer pending block", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/newer-pending-stop-failure";
  const userMessages: string[] = [];
  let resolveOlder: ((result: DispatchResult) => void) | undefined;
  let resolveNewer: ((result: DispatchResult) => void) | undefined;
  const handlers = createLifecycleHandlers({
    runDispatch: async (event, _cwd, payload) => {
      if (event === "SessionStart") return stubDispatchResult({});
      return new Promise<DispatchResult>((resolve) => {
        if (payload.stop_order === 1) resolveOlder = resolve;
        else resolveNewer = resolve;
      });
    },
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  const olderFailure = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  const newerBlocked = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  resolveNewer?.(stubDispatchResult({ block: true, block_reason: "newer policy result" }));
  await newerBlocked;
  resolveOlder?.(stubStopDispatchFailure("dispatch.py exited 1: stale"));
  await olderFailure;

  assert.deepEqual(userMessages, ["newer policy result"]);
  assert.equal(readPendingBlock(cwd, sessionId)?.stop_order, 2);
  assert.equal(handlers.stopDispatchFailureCount(), 0);
});

test("gaia-lifecycle: an older Stop failure rechecks ordering after re-engagement preparation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/failed-stop-reengagement-race";
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  let resolveBeforeEntered: (() => void) | undefined;
  let resolveBeforeReleased: (() => void) | undefined;
  const beforeEntered = new Promise<void>((resolve) => {
    resolveBeforeEntered = resolve;
  });
  const beforeReleased = new Promise<void>((resolve) => {
    resolveBeforeReleased = resolve;
  });
  const handlers = createLifecycleHandlers({
    runDispatch: async (event, _cwd, payload) => {
      if (event === "SessionStart") return stubDispatchResult({});
      return payload.stop_order === 1
        ? stubStopDispatchFailure("dispatch.py exited 1: stale")
        : stubDispatchResult({});
    },
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    beforeReengagement: async () => {
      resolveBeforeEntered?.();
      await beforeReleased;
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  const olderFailure = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  await beforeEntered;
  await handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  resolveBeforeReleased?.();
  await olderFailure;

  assert.deepEqual(userMessages, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(handlers.stopDispatchFailureCount(), 0);
  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

test("gaia-lifecycle: an older healthy Stop preserves a newer failure budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/newer-stop-failure";
  let resolveOlder: ((result: DispatchResult) => void) | undefined;
  let resolveNewer: ((result: DispatchResult) => void) | undefined;
  const handlers = createLifecycleHandlers({
    runDispatch: async (event, _cwd, payload) => {
      if (event === "SessionStart") return stubDispatchResult({});
      return new Promise<DispatchResult>((resolve) => {
        if (payload.stop_order === 1) resolveOlder = resolve;
        else resolveNewer = resolve;
      });
    },
    sendUserMessage: (_content, completionBlock) => {
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  const olderHealthy = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  const newerFailure = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  resolveNewer?.(stubStopDispatchFailure("dispatch.py exited 1: newer"));
  await newerFailure;
  resolveOlder?.(stubDispatchResult({}));
  await olderHealthy;

  assert.equal(handlers.stopDispatchFailureCount(), 1);
  assert.equal(readPendingBlock(cwd, sessionId)?.stop_order, 2);
});

test("gaia-lifecycle: a healthy Stop retires its superseded pending block", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/healthy-stop";
  persistPendingBlock(cwd, sessionId, "superseded completion", "dispatch-superseded", process.pid, undefined, 1);
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, {
    session_id: sessionId,
    dispatch_id: "dispatch-healthy",
    stop_order: 2,
  });

  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

test("gaia-lifecycle: extension input preserves pending Stop-dispatch failure state", async () => {
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      event === "Stop"
        ? stubStopDispatchFailure("dispatch.py exited 1")
        : stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onInput("/tmp/project", { prompt: "retry", source: "extension" });

  assert.equal(handlers.stopDispatchFailureCount(), 2);
});

test("gaia-lifecycle: streaming input preserves pending Stop-dispatch failure state", async () => {
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) =>
      event === "Stop"
        ? stubStopDispatchFailure("dispatch.py exited 1")
        : stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onAgentSettled("/tmp/project", {});
  await handlers.onInput("/tmp/project", {
    prompt: "retry",
    source: "interactive",
    streamingBehavior: "steer",
  });

  assert.equal(handlers.stopDispatchFailureCount(), 2);
});

test("gaia-lifecycle: an older healthy Stop preserves a newer pending block", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/healthy-stop-race";
  persistPendingBlock(
    cwd,
    sessionId,
    "newer completion",
    "dispatch-newer",
    process.pid,
    undefined,
    2,
  );
  const handlers = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, {
    session_id: sessionId,
    dispatch_id: "dispatch-older-healthy",
    stop_order: 1,
  });

  assert.equal(readPendingBlock(cwd, sessionId)?.dispatch_id, "dispatch-newer");
});

test("gaia-lifecycle: an older blocked Stop cannot recreate a block after a newer healthy Stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/blocked-stop-race";
  const userMessages: string[] = [];
  const healthy = createLifecycleHandlers({
    runDispatch: async () => stubDispatchResult({}),
    sendUserMessage: () => {},
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });
  const olderBlocked = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({ block: true, block_reason: "stale completion" }),
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await healthy.onSessionStart(cwd, { session_id: sessionId });
  await healthy.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  await olderBlocked.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });

  assert.deepEqual(userMessages, []);
  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

test("gaia-lifecycle: an older blocked Stop rechecks ordering after re-engagement preparation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  const sessionId = "session/blocked-stop-reengagement-race";
  const userMessages: string[] = [];
  let beforeCalls = 0;
  let resolveOlderBefore: (() => void) | undefined;
  let releaseOlderBefore: (() => void) | undefined;
  const olderBeforeEntered = new Promise<void>((resolve) => {
    resolveOlderBefore = resolve;
  });
  const olderBeforeReleased = new Promise<void>((resolve) => {
    releaseOlderBefore = resolve;
  });
  const handlers = createLifecycleHandlers({
    runDispatch: async (_event, _cwd, payload) =>
      stubDispatchResult({
        block: true,
        block_reason: `${payload.stop_order === 1 ? "older" : "newer"} policy result`,
      }),
    sendUserMessage: (content, completionBlock) => {
      userMessages.push(content);
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
        );
      }
    },
    sendMessage: () => {},
    beforeReengagement: async () => {
      beforeCalls += 1;
      if (beforeCalls === 1) {
        resolveOlderBefore?.();
        await olderBeforeReleased;
      }
    },
    appendEntry: noopAppendEntry,
  });

  const olderBlocked = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });
  await olderBeforeEntered;
  const newerBlocked = handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 2 });
  await newerBlocked;
  releaseOlderBefore?.();
  await olderBlocked;

  assert.deepEqual(userMessages, ["newer policy result"]);
  assert.equal(readPendingBlock(cwd, sessionId)?.stop_order, 2);
});

test("gaia-lifecycle: a blocked Stop retains its invocation branch across dispatch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-finalization-"));
  execFileSync("git", ["init", "-q", "-b", "before"], { cwd });
  const sessionId = "session/stop-branch-snapshot";
  const handlers = createLifecycleHandlers({
    runDispatch: async (event) => {
      if (event === "Stop") {
        execFileSync("git", ["branch", "-m", "after"], { cwd });
        return stubDispatchResult({ block: true, block_reason: "finish the old branch" });
      }
      return stubDispatchResult({});
    },
    sendUserMessage: (_content, completionBlock) => {
      if (completionBlock) {
        persistPendingBlock(
          cwd,
          completionBlock.session_id,
          completionBlock.message,
          completionBlock.dispatch_id,
          completionBlock.owner_pid,
          completionBlock.owner_process_start,
          completionBlock.stop_order,
          completionBlock.branch_name,
        );
      }
    },
    sendMessage: () => {},
    appendEntry: noopAppendEntry,
  });

  await handlers.onSessionStart(cwd, { session_id: sessionId });
  await handlers.onAgentSettled(cwd, { session_id: sessionId, stop_order: 1 });

  const pendingPath = join(
    cwd,
    ".gaia",
    "pi-finalization",
    `pending-block-${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
  assert.equal(pending.branch_name, "before");
  assert.equal(readPendingBlock(cwd, sessionId), undefined);
});

// ── Stop advisory surfacing (PR 3535 review round 2 P2 finding G) ────────

test("gaia-lifecycle: a non-blocking Stop dispatch surfaces advisory stderr via sendMessage", async () => {
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({
        block: false,
        results: [
          {
            hook: "stop-worktree-tmp-artifacts.py",
            decision: "allow",
            stderr: "leaked artifact: /tmp/scratch-abc",
          },
        ],
      }),
    sendUserMessage: () => {},
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /stop-worktree-tmp-artifacts\.py/);
  assert.match(sentMessages[0], /leaked artifact/);
});

test("gaia-lifecycle: a blocking Stop dispatch surfaces only the block reason, not the advisory", async () => {
  const userMessages: string[] = [];
  const sentMessages: string[] = [];
  const handlers = createLifecycleHandlers({
    runDispatch: async () =>
      stubDispatchResult({
        block: true,
        block_reason: "local completion policy: branch has no upstream",
        results: [{ hook: "some-other-hook.py", decision: "allow", stdout: "noise" }],
      }),
    sendUserMessage: (content) => {
      userMessages.push(content);
    },
    sendMessage: (content) => {
      sentMessages.push(content);
    },
    appendEntry: noopAppendEntry,
  });

  await handlers.onAgentSettled("/tmp/project", {});

  assert.deepEqual(userMessages, ["local completion policy: branch has no upstream"]);
  assert.deepEqual(sentMessages, []);
});

// ── Budget guard model/context_window payload (PR 3535 review round 2 P1 finding D) ──

test("buildToolResultPayload omits model/context_window when unresolved", () => {
  const payload = buildToolResultPayload(
    fakeToolResultEvent(),
    "/tmp/project",
    "session-1",
  );
  assert.equal("model" in payload, false);
  assert.equal("context_window" in payload, false);
});

test("buildToolResultPayload carries context_window matching a fixture models.json entry", () => {
  const payload = buildToolResultPayload(
    fakeToolResultEvent(),
    "/tmp/project",
    "session-1",
    { model: "unsloth/Qwen3.8-27B-GGUF:Q4_K_M", contextWindow: 65536 },
  );
  assert.equal(payload.model, "unsloth/Qwen3.8-27B-GGUF:Q4_K_M");
  assert.equal(payload.context_window, 65536);
});

test("toolResponseFromEvent extracts text content and the error flag", () => {
  const response = toolResponseFromEvent(fakeToolResultEvent({ content: [{ type: "text", text: "42\n" }] }));
  assert.deepEqual(response, { text: "42\n", isError: false });

  const errorResponse = toolResponseFromEvent(
    fakeToolResultEvent({ content: [{ type: "text", text: "boom" }], isError: true }),
  );
  assert.deepEqual(errorResponse, { text: "boom", isError: true });
});

// ── Stale-runtime resilience (drive-run finding, BOU-3084/PR 3541) ──────
//
// Live repro: a plain `pi -p --approve "..."` run in this repo throws
// "Extension error (.pi/extensions/gaia-lifecycle.ts): This extension ctx
// is stale after session replacement or reload." on every invocation —
// root-caused to pi-subagents' periodic background-work snapshot replacing
// the runtime mid-session while gaia-lifecycle's SessionEnd handler is
// still awaiting dispatch.py, so its post-await `pi.appendEntry` call fires
// against an already-invalidated captured `pi`.

test("safePiCall swallows a stale-runtime error and logs instead of throwing", () => {
  const originalConsoleError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    assert.doesNotThrow(() => {
      safePiCall("appendEntry", () => {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
        );
      });
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logged, [
    ["[gaia-lifecycle] appendEntry skipped — extension runtime went stale"],
  ]);
});

test("safePiCall rethrows an unrelated error rather than masking it", () => {
  assert.throws(
    () =>
      safePiCall("sendMessage", () => {
        throw new Error("boom: unrelated failure");
      }),
    /boom: unrelated failure/,
  );
});

test("isStaleRuntimeError only matches Pi's exact stale-runtime error text", () => {
  assert.equal(
    isStaleRuntimeError(new Error("This extension ctx is stale after session replacement or reload.")),
    true,
  );
  assert.equal(isStaleRuntimeError(new Error("some other failure")), false);
  assert.equal(isStaleRuntimeError("not an Error instance"), false);
});

test("gaia-lifecycle.ts never calls a captured pi.sendMessage/sendUserMessage/appendEntry outside safePiCall", () => {
  // Pragmatic lint-level static check (finding text's own suggestion): every
  // direct `pi.<method>(` call site in the default export must be wrapped by
  // `safePiCall(...)`, since ALL of them happen after an `await` on the far
  // side of a dispatch.py round trip — exactly the window a session
  // replacement (by this extension or any other, e.g. pi-subagents) can
  // invalidate the captured `pi`. A bare `pi.appendEntry(...)` (no
  // `safePiCall` on the same or a directly preceding line) reintroduces the
  // uncaught "Extension error" this test guards against.
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const lines = source.split("\n");
  const capturedPiCallPattern = /\bpi\.(sendMessage|sendUserMessage|appendEntry)\(/;
  const bareCallLines: number[] = [];
  lines.forEach((line, index) => {
    if (!capturedPiCallPattern.test(line)) return;
    // The one legitimate bare call site is safePiCall's own `fn()` — never a
    // direct `pi.<method>(` — so any match here must be guarded by
    // `safePiCall(` on this line or one of the two lines above it (covers
    // the common `safePiCall("label", () =>\n  pi.foo(...)` wrap shape).
    const context = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
    if (!context.includes("safePiCall(")) {
      bareCallLines.push(index + 1);
    }
  });
  assert.deepEqual(bareCallLines, []);
});

test("gaia-lifecycle: replay acknowledgement waits for message_start consumption", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  assert.equal(source.includes('pi.on("before_agent_start"'), false);
  assert.equal(source.includes('pi.on("message_start"'), true);
});

test("gaia-lifecycle: replay acknowledgement restarts the follow-on scan window", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const acknowledgementStart = source.indexOf("function acknowledgeAwaitingBlock");
  const messageStart = source.indexOf('pi.on("message_start"', acknowledgementStart);
  assert.ok(acknowledgementStart >= 0);
  assert.ok(messageStart > acknowledgementStart);
  assert.match(
    source.slice(acknowledgementStart, messageStart),
    /resetPendingBlockReplayWindow\(\)/,
  );
});

test("gaia-lifecycle: replay polling reuses a session branch snapshot", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  assert.match(
    source,
    /readSessionPendingBlock\(\s*projectCwd,\s*currentSessionId,\s*replayBranchName/,
  );
  assert.match(source, /replayBranchName = currentBranchName\(projectCwd\)/);
});

test("gaia-lifecycle: input leaves tab color changes to agent_start", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const inputHandler = source.slice(source.indexOf('pi.on("input"'), source.indexOf('pi.on("agent_settled"'));

  assert.doesNotMatch(inputHandler, /setTabColor\(pi, projectCwd, tabColorForState\("working"\)\)/);
  assert.match(inputHandler, /handlers\.onInput\(projectCwd/);
});

test("gaia-lifecycle: pending replay colors red before polling the replay", () => {
  const sourcePath = fileURLToPath(new URL("../src/lifecycle.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf-8");
  const sessionStart = source.slice(source.indexOf('pi.on("session_start"'), source.indexOf('pi.on("session_shutdown"'));

  const colorIndex = sessionStart.indexOf('await safePiAsyncCall("session tab color"');
  const replayIndex = sessionStart.indexOf("replayPendingBlockOnce()");
  assert.ok(colorIndex >= 0 && replayIndex >= 0 && colorIndex < replayIndex);
});

test("buildToolResultPayload forwards a non-null tool_response and the resolved session_id", () => {
  const payload = buildToolResultPayload(
    fakeToolResultEvent({ content: [{ type: "text", text: "ok" }] }),
    "/tmp/project",
    "session-abc-123",
  );

  assert.equal(payload.cwd, "/tmp/project");
  assert.equal(payload.tool_name, "bash");
  assert.notEqual(payload.tool_response, undefined);
  assert.notEqual(payload.tool_response, null);
  assert.deepEqual(payload.tool_response, { text: "ok", isError: false });
  assert.equal(payload.session_id, "session-abc-123");
  assert.notEqual(payload.session_id, "");
});
