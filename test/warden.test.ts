import { test } from "node:test";
import assert from "node:assert/strict";
import {
  couldMatchAnyPreToolUseSpec,
  createWardenHandlers,
  EXTENSION_FAILURE_RELEASE_THRESHOLD,
  isGateDecision,
} from "../src/warden.js";
import type { ToolCallBlockResult } from "../src/warden.js";
import type { RunPythonResult } from "../src/run-python.js";
import type { DispatchResult } from "../src/lib/dispatch.js";

function stubResult(overrides: Partial<RunPythonResult>): RunPythonResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function stubDispatch(overrides: Partial<DispatchResult>): DispatchResult {
  return {
    results: [],
    block: false,
    block_reason: "",
    torn_down: [],
    teardown_warnings: [],
    ...overrides,
  };
}

function noopSendMessage(): void {}

/** A `runDispatchImpl` that fails the test if the PreToolUse dispatch is
 * ever invoked — used to pin that gate.py failures/blocks never reach the
 * dispatch step (deterministic ordering, PR 3535 review round 2 P1 finding C). */
function unreachableDispatch(): Promise<DispatchResult> {
  throw new Error("dispatch.py must not be invoked when gate.py blocks or fails");
}

function allowingDispatch(): Promise<DispatchResult> {
  return Promise.resolve(stubDispatch({}));
}

test("agent-pi-harness-warden: allows when gate.py returns decision=allow and PreToolUse dispatch is clean", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({
        stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }),
      }),
    runDispatchImpl: allowingDispatch,
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("gmake test", "/tmp/project");
  assert.equal(result, undefined);
});
test("agent-pi-harness-warden: blocks when gate.py returns decision=block, never reaching dispatch", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({
        stdout: JSON.stringify({
          decision: "block",
          reason: "gmake/make target references production: 'deploy-prod'",
          rule: "blocks-make-prod-target",
        }),
      }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("gmake deploy-prod", "/tmp/project");
  assert.deepEqual(result, {
    block: true,
    reason: "gmake/make target references production: 'deploy-prod'",
  });
});

test("agent-pi-harness-warden: fails closed on a non-zero gate.py exit, never reaching dispatch", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ code: 1, stderr: "gate.py crashed" }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /gate\.py exited 1/);
});

test("agent-pi-harness-warden: fails closed on unparseable gate.py stdout", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ stdout: "not json" }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /unparseable/);
});

test("agent-pi-harness-warden: fails closed when stdout parses but has the wrong shape", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ stdout: JSON.stringify({ decision: "maybe" }) }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /unexpected payload shape/);
});

test("agent-pi-harness-warden: releases after N consecutive gate.py extension-level failures, never on a policy block", async () => {
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ code: 1, stderr: "python3 unlaunchable" }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const results = [];
  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD; i += 1) {
    results.push(await handlers.handleBashToolCall("echo hi", "/tmp/project"));
  }

  // First two (< threshold) still fail closed.
  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD - 1; i += 1) {
    assert.equal(results[i]?.block, true, `call ${i} should still block`);
  }
  // The Nth (== threshold) call releases: allow, with a loud sendMessage.
  assert.equal(results[EXTENSION_FAILURE_RELEASE_THRESHOLD - 1], undefined);
  assert.equal(handlers.gateFailureCount(), EXTENSION_FAILURE_RELEASE_THRESHOLD);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /released after 3 consecutive gate failures/);
});

test("agent-pi-harness-warden: a well-formed gate.py decision resets gateFailureCount even when the command is a prefilter no-op", async () => {
  // PR 3541 review finding (P1, third round): a healthy gate.py call is
  // proof the GATE boundary recovered regardless of whether the command
  // goes on to invoke dispatch.py at all — reaching dispatch.py is a
  // separate, independent boundary with its own streak.
  let stdout = "not json";
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ stdout }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  await handlers.handleBashToolCall("echo hi", "/tmp/project");
  await handlers.handleBashToolCall("echo hi", "/tmp/project");
  assert.equal(handlers.gateFailureCount(), 2);

  // "echo hi" is a prefilter no-op (never matches couldMatchAnyPreToolUseSpec),
  // so dispatch.py is never invoked here — yet the gate streak still resets
  // because gate.py itself produced a well-formed decision.
  stdout = JSON.stringify({ decision: "allow", reason: "", rule: "ok" });
  const result = await handlers.handleBashToolCall("echo hi", "/tmp/project");
  assert.equal(result, undefined);
  assert.equal(handlers.gateFailureCount(), 0);
  assert.equal(handlers.dispatchFailureCount(), 0);
});

test("agent-pi-harness-warden: a clean dispatch.py round trip resets dispatchFailureCount independent of gateFailureCount", async () => {
  let dispatchTeardownWarnings: string[] = ["dispatch.py exited 1: boom"];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () => stubDispatch({ teardown_warnings: dispatchTeardownWarnings }),
    sendMessage: noopSendMessage,
  });

  await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(handlers.dispatchFailureCount(), 2);
  assert.equal(
    handlers.gateFailureCount(),
    0,
    "gate.py succeeded on every call, so its own streak was never touched",
  );

  dispatchTeardownWarnings = [];
  const result = await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(result, undefined);
  assert.equal(handlers.dispatchFailureCount(), 0);
});

test("agent-pi-harness-warden: onSessionStart resets gateFailureCount", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () => stubResult({ code: 1, stderr: "crashed" }),
    runDispatchImpl: unreachableDispatch,
    sendMessage: noopSendMessage,
  });

  await handlers.handleBashToolCall("echo hi", "/tmp/project");
  await handlers.handleBashToolCall("echo hi", "/tmp/project");
  assert.equal(handlers.gateFailureCount(), 2);

  handlers.onSessionStart();
  assert.equal(handlers.gateFailureCount(), 0);
  assert.equal(handlers.dispatchFailureCount(), 0);
});

test("agent-pi-harness-warden: onSessionStart resets a nonzero dispatchFailureCount too", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () =>
      stubDispatch({ teardown_warnings: ["dispatch.py exited 1: boom"] }),
    sendMessage: noopSendMessage,
  });

  await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.equal(handlers.dispatchFailureCount(), 2);

  handlers.onSessionStart();
  assert.equal(handlers.gateFailureCount(), 0);
  assert.equal(handlers.dispatchFailureCount(), 0);
});

test("isGateDecision narrows a well-formed payload and rejects a malformed one", () => {
  assert.equal(isGateDecision({ decision: "allow", reason: "", rule: "ok" }), true);
  assert.equal(isGateDecision({ decision: "maybe" }), false);
  assert.equal(isGateDecision(null), false);
});

test("couldMatchAnyPreToolUseSpec: over-broad supersets mirroring the manifest matchers (BOU-3092 option B)", () => {
  assert.equal(couldMatchAnyPreToolUseSpec("ls -la"), false);
  assert.equal(couldMatchAnyPreToolUseSpec("grep -rn foo ."), false);
  assert.equal(couldMatchAnyPreToolUseSpec("gmake test"), false);

  assert.equal(couldMatchAnyPreToolUseSpec("git push origin main"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("npm run push-release"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("git commit -m wip"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("cat /tmp/x"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("echo hi > out.txt"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("cat < in.txt"), true);

  // PR 3541 review finding (P2): pre-bash-worktree-tmp-write.py also
  // matches a bare worktree-relative "tmp/..." form with NO leading slash
  // and no redirect char — the prefilter must be a strict SUPERSET of every
  // real manifest matcher, never a subset. A false positive here only costs
  // a dispatch.py spawn that comes back empty; missing a command the real
  // hook WOULD have matched is the failure mode this invariant exists to
  // prevent.
  assert.equal(couldMatchAnyPreToolUseSpec("mkdir -p tmp/proofs/screenshots"), true);
  assert.equal(
    couldMatchAnyPreToolUseSpec("PROOF_BUNDLE_ROOT=tmp/screenshots ./run.sh"),
    true,
  );
  assert.equal(couldMatchAnyPreToolUseSpec("cp out.png tmp/e2e/out.png"), true);
});

test("couldMatchAnyPreToolUseSpec: detects option-bearing and absolute git commit commands", () => {
  assert.equal(couldMatchAnyPreToolUseSpec("git -C /worktree commit -m message"), true);
  assert.equal(couldMatchAnyPreToolUseSpec("/usr/bin/git --work-tree=/worktree commit"), true);
});

// ── PreToolUse dispatch wiring (PR 3535 review round 2 P1 finding C) ──────

test("agent-pi-harness-warden: a PreToolUse dispatch block propagates as a tool-call block", async () => {
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () =>
      stubDispatch({ block: true, block_reason: "pre-push-merged-branch-guard.py: blocked" }),
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  assert.deepEqual(result, {
    block: true,
    reason: "pre-push-merged-branch-guard.py: blocked",
  });
});

test("agent-pi-harness-warden: a non-blocking PreToolUse advisory surfaces via sendMessage", async () => {
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () =>
      stubDispatch({
        results: [
          { hook: "pre-bash-worktree-tmp-write.py", decision: "allow", stdout: "advisory note" },
        ],
      }),
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const result = await handlers.handleBashToolCall("cat /tmp/scratch.txt", "/tmp/project");
  assert.equal(result, undefined);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /pre-bash-worktree-tmp-write\.py/);
  assert.match(sent[0], /advisory note/);
});

test("agent-pi-harness-warden: a matcher-filtered PreToolUse dispatch (no specs matched) is a silent no-op", async () => {
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () => stubDispatch({ results: [] }),
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  // "git commit" passes the BOU-3092 option B prefilter (so this exercises
  // dispatch.py's OWN matcher-filtering returning empty results), unlike a
  // prefilter-skipped command which never reaches runDispatchImpl at all
  // (covered separately below).
  const result = await handlers.handleBashToolCall("git commit -m wip", "/tmp/project");
  assert.equal(result, undefined);
  assert.deepEqual(sent, []);
});

test("agent-pi-harness-warden: BOU-3092 option B prefilter skips the dispatch.py spawn for an ls-class command", async () => {
  let dispatchCalls = 0;
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () => {
      dispatchCalls += 1;
      return stubDispatch({});
    },
    sendMessage: noopSendMessage,
  });

  const result = await handlers.handleBashToolCall("ls -la", "/tmp/project");
  assert.equal(result, undefined);
  assert.equal(dispatchCalls, 0, "dispatch.py must not be spawned for a command no spec could match");
});

test("agent-pi-harness-warden: BOU-3092 option B prefilter still dispatches push/tmp/redirect/git-commit commands", async () => {
  let dispatchCalls = 0;
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () => {
      dispatchCalls += 1;
      return stubDispatch({});
    },
    sendMessage: noopSendMessage,
  });

  await handlers.handleBashToolCall("git push origin main", "/tmp/project");
  await handlers.handleBashToolCall("echo hi > /tmp/out.txt", "/tmp/project");
  await handlers.handleBashToolCall("git commit -m wip", "/tmp/project");
  await handlers.handleBashToolCall("cat foo.txt < bar.txt", "/tmp/project");

  assert.equal(dispatchCalls, 4);
});

test("agent-pi-harness-warden: PreToolUse dispatch-invocation failures release independently of gateFailureCount", async () => {
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () =>
      stubDispatch({ teardown_warnings: ["dispatch.py exited 1: boom"] }),
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const results = [];
  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD; i += 1) {
    results.push(await handlers.handleBashToolCall("git push origin main", "/tmp/project"));
  }

  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD - 1; i += 1) {
    assert.equal(results[i]?.block, true, `call ${i} should still block`);
  }
  assert.equal(results[EXTENSION_FAILURE_RELEASE_THRESHOLD - 1], undefined);
  assert.equal(handlers.dispatchFailureCount(), EXTENSION_FAILURE_RELEASE_THRESHOLD);
  assert.equal(handlers.gateFailureCount(), 0, "gate.py succeeded on every call in this run");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /released after 3 consecutive dispatch failures/);
});

test("agent-pi-harness-warden: an interleaved prefilter no-op does not mask a broken dispatch.py's failure streak", async () => {
  // PR 3541 review finding (P1, second round): the prefilter no-op path
  // used to reset the (then-shared) failure counter unconditionally — a
  // genuine no-op (it never probed dispatch.py at all) is not evidence the
  // dispatch.py boundary is healthy. That masked a broken dispatch.py
  // whenever a non-matching command (e.g. `ls`) interleaved with a
  // matching one (e.g. `git push`): the streak never reached the release
  // threshold, so every later push stayed blocked forever instead of
  // eventually releasing.
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) }),
    runDispatchImpl: async () =>
      stubDispatch({ teardown_warnings: ["dispatch.py exited 1: boom"] }),
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const results = [];
  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD; i += 1) {
    results.push(await handlers.handleBashToolCall("git push origin main", "/tmp/project"));
    // A prefilter-skipped no-op interleaved between every failing dispatch
    // attempt — this must NOT reset the dispatch streak. gate.py DOES
    // succeed on this call (it's a well-formed "allow"), so gateFailureCount
    // stays at 0 throughout — it was never incremented in this run.
    const noop = await handlers.handleBashToolCall("ls -la", "/tmp/project");
    assert.equal(noop, undefined);
  }

  for (let i = 0; i < EXTENSION_FAILURE_RELEASE_THRESHOLD - 1; i += 1) {
    assert.equal(results[i]?.block, true, `push attempt ${i} should still block`);
  }
  // Despite the interleaved no-ops, the streak still reaches the threshold
  // and the final matching (push) attempt releases.
  assert.equal(results[EXTENSION_FAILURE_RELEASE_THRESHOLD - 1], undefined);
  assert.equal(handlers.dispatchFailureCount(), EXTENSION_FAILURE_RELEASE_THRESHOLD);
  assert.equal(handlers.gateFailureCount(), 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /released after 3 consecutive dispatch failures/);
});

test("agent-pi-harness-warden: gate.py and dispatch.py failure streaks release independently under cross-source interleaving", async () => {
  // PR 3541 review finding (P1, third round, fresh evidence): with a SHARED
  // counter, a healthy call on one boundary reset evidence of an ongoing
  // failure on the OTHER — isolated gate.py failures separated by healthy
  // gate.py calls (each of which also happens to fail on dispatch.py) could
  // accumulate toward the release threshold without either boundary ever
  // failing 3 times CONSECUTIVELY. This test alternates: gate.py fails,
  // then gate.py succeeds but dispatch.py fails, repeated three times. Every
  // gate.py failure is immediately followed by a gate.py success, so
  // gateFailureCount must never exceed 1 and must NEVER release — while
  // dispatchFailureCount accumulates across the three (non-consecutive,
  // but consecutive-among-dispatch-invocations) dispatch.py failures and
  // releases exactly on the third.
  const sent: string[] = [];
  let callIndex = 0;
  const gateOutcomes: Array<"fail" | "allow"> = ["fail", "allow", "fail", "allow", "fail", "allow"];
  const handlers = createWardenHandlers({
    runPythonImpl: async () => {
      const outcome = gateOutcomes[callIndex];
      return outcome === "fail"
        ? stubResult({ code: 1, stderr: "gate.py crashed" })
        : stubResult({ stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }) });
    },
    runDispatchImpl: async () =>
      stubDispatch({ teardown_warnings: ["dispatch.py exited 1: boom"] }),
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const results: Array<ToolCallBlockResult | undefined> = [];
  for (; callIndex < gateOutcomes.length; callIndex += 1) {
    results.push(await handlers.handleBashToolCall("git push origin main", "/tmp/project"));
    if (callIndex < gateOutcomes.length - 1) {
      // gateFailureCount must stay bounded at 1 throughout: it never gets a
      // chance to accumulate because every failure is immediately followed
      // by a success.
      assert.ok(
        handlers.gateFailureCount() <= 1,
        `gateFailureCount must never exceed 1 mid-run, was ${handlers.gateFailureCount()} after call ${callIndex}`,
      );
    }
  }

  // Calls: 0=gate fail (block), 1=gate ok/dispatch fail #1 (block),
  // 2=gate fail (block), 3=gate ok/dispatch fail #2 (block),
  // 4=gate fail (block), 5=gate ok/dispatch fail #3 == threshold (releases).
  for (let i = 0; i < results.length - 1; i += 1) {
    assert.equal(results[i]?.block, true, `call ${i} should still block`);
  }
  assert.equal(results[results.length - 1], undefined, "the third dispatch failure releases");

  assert.equal(
    handlers.gateFailureCount(),
    0,
    "gateFailureCount never reached the release threshold — each failure was reset by the next healthy gate call, and the run ends on a healthy call",
  );
  assert.equal(handlers.dispatchFailureCount(), EXTENSION_FAILURE_RELEASE_THRESHOLD);
  assert.equal(sent.length, 1, "only dispatch.py's streak released — gate.py's never did");
  assert.match(sent[0], /released after 3 consecutive dispatch failures/);
});

test("agent-pi-harness-warden: surfaces gate.py's release warning instead of a silent allow", async () => {
  const sent: string[] = [];
  const handlers = createWardenHandlers({
    runPythonImpl: async () =>
      stubResult({
        stdout: JSON.stringify({
          decision: "allow",
          reason: "gate released after 3 consecutive gate-error failures — fix the gate",
          rule: "gate-error-released",
        }),
      }),
    runDispatchImpl: allowingDispatch,
    sendMessage: (content) => {
      sent.push(content);
    },
  });

  const result = await handlers.handleBashToolCall("echo hi", "/tmp/project");
  assert.equal(result, undefined);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /gate\.py released with a warning/);
  assert.match(sent[0], /gate-error failures/);
});
