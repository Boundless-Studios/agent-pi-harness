import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifecycleHandlers } from "../src/lifecycle.js";
import { createWardenHandlers } from "../src/warden.js";
import {
  createProjectAdapterV1,
  parseProjectAdapterV1,
  type ProjectAdapterV1
} from "../src/project-adapter.js";
import { GAIA_FIXTURE_ADAPTER } from "./fixtures/gaia-adapter.js";

const validAdapter: ProjectAdapterV1 = {
  version: 1,
  projectPaths: {
    stateRoot: ".harness/state",
    configRoot: "config",
    modelsFile: "models.json",
    skillManifestFile: "skills.json"
  },
  policyArgv: {
    gate: { script: "hooks/gate.py", argv: ["--project-dir", "{cwd}"] },
    dispatch: {
      script: "hooks/dispatch.py",
      argv: ["--event", "{event}", "--project-dir", "{cwd}"]
    }
  },
  skillRoots: [".skills"],
  lifecycleIntentArgv: {
    tabColor: ["true"],
    operatorStatus: ["true"]
  },
  timeouts: {
    policyMs: 1_000,
    tabColorMs: 2_000,
    operatorStatusMs: 3_000
  },
  sessionIdEnv: "AGENT_SESSION_ID",
  modelProvider: "example"
};

test("project adapter validation deeply freezes a version-one config", () => {
  const adapter = createProjectAdapterV1(validAdapter);

  assert.deepEqual(adapter, validAdapter);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.projectPaths), true);
  assert.equal(Object.isFrozen(adapter.policyArgv), true);
  assert.equal(Object.isFrozen(adapter.policyArgv.gate), true);
  assert.equal(Object.isFrozen(adapter.policyArgv.gate.argv), true);
  assert.equal(Object.isFrozen(adapter.skillRoots), true);
  assert.equal(Object.isFrozen(adapter.lifecycleIntentArgv), true);
  assert.equal(Object.isFrozen(adapter.timeouts), true);
});

test("project adapter validation rejects malformed or unsafe config", () => {
  assert.throws(
    () => parseProjectAdapterV1({ ...validAdapter, version: 2 }),
    /version/,
  );
  assert.throws(
    () =>
      parseProjectAdapterV1({
        ...validAdapter,
        projectPaths: { ...validAdapter.projectPaths, stateRoot: "/absolute/state" }
      }),
    /relative/,
  );
  assert.throws(
    () =>
      parseProjectAdapterV1({
        ...validAdapter,
        skillRoots: ["../outside"]
      }),
    /relative/,
  );
  assert.throws(
    () =>
      parseProjectAdapterV1({
        ...validAdapter,
        timeouts: { ...validAdapter.timeouts, policyMs: 0 }
      }),
    /positive/,
  );
});

test("Gaia parity adapter keeps the extracted project bindings outside the runtime", () => {
  assert.equal(GAIA_FIXTURE_ADAPTER.projectPaths.stateRoot, ".gaia/pi-finalization");
  assert.equal(GAIA_FIXTURE_ADAPTER.policyArgv.gate.script, "scripts/pi-hooks/gate.py");
  assert.deepEqual(GAIA_FIXTURE_ADAPTER.skillRoots, [".claude/skills"]);
  assert.equal(Object.isFrozen(GAIA_FIXTURE_ADAPTER), true);
});

test("lifecycle handlers pass the adapter through dispatch and durable state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-adapter-lifecycle-"));
  let dispatchAdapter: ProjectAdapterV1 | undefined;
  try {
    const handlers = createLifecycleHandlers({
      adapter: validAdapter,
      runDispatch: async (_event, _cwd, _payload, adapter) => {
        dispatchAdapter = adapter;
        return {
          results: [],
          block: false,
          block_reason: "",
          torn_down: [],
          teardown_warnings: [],
        };
      },
      sendUserMessage: () => undefined,
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    });
    await handlers.onAgentSettled(cwd, { session_id: "adapter-session" });
    assert.equal(dispatchAdapter, validAdapter);
    assert.equal(existsSync(join(cwd, validAdapter.projectPaths.stateRoot)), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("warden handlers pass adapter commands, arguments, timeout, and identity", async () => {
  const gateCalls: Array<{
    script: string;
    argv: readonly string[];
    timeoutMs: number | undefined;
  }> = [];
  let dispatchAdapter: ProjectAdapterV1 | undefined;
  const handlers = createWardenHandlers({
    adapter: validAdapter,
    runPythonImpl: async (script, argv, _payload, _cwd, _env, timeoutMs) => {
      gateCalls.push({ script, argv, timeoutMs });
      return {
        code: 0,
        stdout: JSON.stringify({ decision: "allow", reason: "", rule: "ok" }),
        stderr: "",
      };
    },
    runDispatchImpl: async (_event, _cwd, _payload, adapter) => {
      dispatchAdapter = adapter;
      return {
        results: [],
        block: false,
        block_reason: "",
        torn_down: [],
        teardown_warnings: [],
      };
    },
    sendMessage: () => undefined,
  });

  assert.equal(await handlers.handleBashToolCall("git push origin main", "/worktree"), undefined);
  assert.deepEqual(gateCalls, [
    {
      script: "hooks/gate.py",
      argv: ["--project-dir", "/worktree"],
      timeoutMs: 1_000,
    },
  ]);
  assert.equal(dispatchAdapter, validAdapter);
});
