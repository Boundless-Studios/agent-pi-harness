import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveModelContext } from "../src/lib/model-context.js";
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
  lifecycleIntentArgv: {
    tabColor: ["true"],
    operatorStatus: ["true"],
  },
  timeouts: { policyMs: 1_000, tabColorMs: 1_000, operatorStatusMs: 1_000 },
  sessionIdEnv: "MODEL_CONTEXT_SESSION",
  modelProvider: "example",
});

function withLaunchEnvironment<T>(fn: () => T): T {
  const provider = process.env.PI_LAUNCH_PROVIDER;
  const model = process.env.PI_LAUNCH_MODEL;
  delete process.env.PI_LAUNCH_PROVIDER;
  delete process.env.PI_LAUNCH_MODEL;
  try {
    return fn();
  } finally {
    if (provider === undefined) delete process.env.PI_LAUNCH_PROVIDER;
    else process.env.PI_LAUNCH_PROVIDER = provider;
    if (model === undefined) delete process.env.PI_LAUNCH_MODEL;
    else process.env.PI_LAUNCH_MODEL = model;
  }
}

test("resolveModelContext accepts a validated nested provider/model document", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-model-context-"));
  try {
    const configRoot = join(cwd, "config");
    mkdirSync(configRoot);
    writeFileSync(
      join(configRoot, "models.json"),
      JSON.stringify({
        providers: {
          example: {
            models: [{ id: "model-a", contextWindow: 65_536 }],
          },
        },
      }),
    );
    assert.deepEqual(
      withLaunchEnvironment(() => resolveModelContext(cwd, undefined, adapter)),
      { model: "model-a", contextWindow: 65_536 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveModelContext rejects malformed nested model JSON instead of throwing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-model-context-"));
  try {
    const configRoot = join(cwd, "config");
    mkdirSync(configRoot);
    writeFileSync(
      join(configRoot, "models.json"),
      JSON.stringify({ providers: { example: { models: { id: "not-an-array" } } } }),
    );
    const malformed = withLaunchEnvironment(() => resolveModelContext(cwd, undefined, adapter));
    assert.equal(malformed.model, undefined);
    assert.equal(malformed.contextWindow, undefined);

    writeFileSync(
      join(configRoot, "models.json"),
      JSON.stringify({ providers: { example: { models: [{ id: "bad", contextWindow: 0 }] } } }),
    );
    const invalidWindow = withLaunchEnvironment(() => resolveModelContext(cwd, undefined, adapter));
    assert.equal(invalidWindow.model, undefined);
    assert.equal(invalidWindow.contextWindow, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveModelContext uses the active runtime model for fallback lookup", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-model-context-"));
  try {
    const configRoot = join(cwd, "config");
    mkdirSync(configRoot);
    writeFileSync(
      join(configRoot, "models.json"),
      JSON.stringify({
        providers: {
          example: {
            models: [
              { id: "launch-model", contextWindow: 200_000 },
              { id: "switched-model", contextWindow: 32_768 },
            ],
          },
        },
      }),
    );
    const context = {
      model: { id: "switched-model" },
      getContextUsage: () => undefined,
    } as any;

    assert.deepEqual(
      withLaunchEnvironment(() => resolveModelContext(cwd, context, adapter)),
      { model: "switched-model", contextWindow: 32_768 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
