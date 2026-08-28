import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSessionId } from "../src/lib/session.js";
import { createProjectAdapterV1 } from "../src/project-adapter.js";

const adapter = createProjectAdapterV1({
  version: 1,
  projectPaths: {
    stateRoot: ".state",
    configRoot: "config",
    modelsFile: "models.json",
    skillManifestFile: "skills.json",
  },
  policyArgv: {
    gate: { script: "hooks/gate.py", argv: [] },
    dispatch: { script: "hooks/dispatch.py", argv: [] },
  },
  skillRoots: ["skills"],
  lifecycleIntentArgv: { tabColor: ["true"], operatorStatus: ["true"] },
  timeouts: { policyMs: 1_000, tabColorMs: 1_000, operatorStatusMs: 1_000 },
  sessionIdEnv: "PI_HARNESS_TEST_SESSION_ID",
  modelProvider: "example",
});

test("session fallback identity is stable per runtime and distinct across runtimes", () => {
  const previous = process.env[adapter.sessionIdEnv];
  delete process.env[adapter.sessionIdEnv];
  const first = { sessionManager: { getSessionId: () => "" } } as any;
  const second = { sessionManager: { getSessionId: () => undefined } } as any;
  try {
    const firstId = resolveSessionId(first, adapter);
    assert.notEqual(firstId, "");
    assert.equal(resolveSessionId(first, adapter), firstId);
    assert.notEqual(resolveSessionId(second, adapter), firstId);
  } finally {
    if (previous === undefined) delete process.env[adapter.sessionIdEnv];
    else process.env[adapter.sessionIdEnv] = previous;
  }
});
