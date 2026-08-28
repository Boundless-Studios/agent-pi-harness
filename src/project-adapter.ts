import { isAbsolute, join } from "node:path";

/** The version of the project integration contract understood by this runtime. */
export const PROJECT_ADAPTER_VERSION = 1 as const;

export interface ProjectPathsV1 {
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly modelsFile: string;
  readonly skillManifestFile: string;
}

export interface PolicyCommandV1 {
  readonly script: string;
  readonly argv: readonly string[];
}

export interface PolicyArgvV1 {
  readonly gate: PolicyCommandV1;
  readonly dispatch: PolicyCommandV1;
}

export interface LifecycleIntentArgvV1 {
  readonly tabColor: readonly string[];
  readonly operatorStatus: readonly string[];
}

export interface ProjectTimeoutsV1 {
  readonly policyMs: number;
  readonly tabColorMs: number;
  readonly operatorStatusMs: number;
}

export interface ProjectAdapterV1 {
  readonly version: typeof PROJECT_ADAPTER_VERSION;
  readonly projectPaths: ProjectPathsV1;
  readonly policyArgv: PolicyArgvV1;
  readonly skillRoots: readonly string[];
  readonly lifecycleIntentArgv: LifecycleIntentArgvV1;
  readonly timeouts: ProjectTimeoutsV1;
  readonly sessionIdEnv: string;
  readonly modelProvider: string;
  readonly budgetContextEnv?: string;
}

export type ProjectAdapterV1Input = {
  readonly version: number;
  readonly projectPaths: ProjectPathsV1;
  readonly policyArgv: PolicyArgvV1;
  readonly skillRoots: readonly string[];
  readonly lifecycleIntentArgv: LifecycleIntentArgvV1;
  readonly timeouts: ProjectTimeoutsV1;
  readonly sessionIdEnv: string;
  readonly modelProvider: string;
  readonly budgetContextEnv?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  scope: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${scope} has unknown key ${JSON.stringify(key)}`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) {
    throw new TypeError(`${field} must be a relative path`);
  }
  if (value.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new TypeError(`${field} must be a relative path and must not escape the project root`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TypeError(`${field} contains an invalid character`);
  }
}

function assertArgv(value: unknown, field: string, requireOne = false): asserts value is readonly string[] {
  if (!Array.isArray(value) || (requireOne && value.length === 0)) {
    throw new TypeError(`${field} must be a non-empty string array`);
  }
  for (const [index, argument] of value.entries()) {
    assertNonEmptyString(argument, `${field}[${index}]`);
    if (argument.includes("\0") || argument.includes("\n") || argument.includes("\r")) {
      throw new TypeError(`${field}[${index}] contains an invalid character`);
    }
  }
}

function assertLifecycleIntentArgv(value: unknown, field: string): asserts value is readonly string[] {
  assertArgv(value, field, true);
  const [executable, ...argv] = value;
  if (
    executable.startsWith("./") ||
    executable.startsWith("../") ||
    executable.startsWith(".\\") ||
    executable.startsWith("..\\")
  ) {
    throw new TypeError(`${field}[0] must not be a relative executable`);
  }

  const executableName = executable.split(/[\\/]/).at(-1)?.toLowerCase();
  const usesShellCommand =
    executableName !== undefined &&
    ["sh", "bash", "zsh", "dash"].includes(executableName) &&
    argv.includes("-c");
  const usesInterpreterCommand =
    executableName !== undefined &&
    ["python", "python3", "node"].includes(executableName) &&
    argv.some((argument) => argument === "-c" || argument === "-e");
  if (usesShellCommand || usesInterpreterCommand) {
    throw new TypeError(`${field} must not use a shell or interpreter command string`);
  }
}

function assertPositiveTimeout(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertProjectAdapterShape(value: unknown): asserts value is ProjectAdapterV1Input {
  if (!isRecord(value)) throw new TypeError("project adapter must be an object");
  assertAllowedKeys(
    value,
    [
      "version",
      "projectPaths",
      "policyArgv",
      "skillRoots",
      "lifecycleIntentArgv",
      "timeouts",
      "sessionIdEnv",
      "modelProvider",
      "budgetContextEnv",
    ],
    "project adapter",
  );
  if (value.version !== PROJECT_ADAPTER_VERSION) {
    throw new TypeError(`project adapter version must be ${PROJECT_ADAPTER_VERSION}`);
  }
  const paths = value.projectPaths;
  if (!isRecord(paths)) throw new TypeError("projectPaths must be an object");
  assertAllowedKeys(
    paths,
    ["stateRoot", "configRoot", "modelsFile", "skillManifestFile"],
    "projectPaths",
  );
  assertRelativePath(paths.stateRoot, "projectPaths.stateRoot");
  assertRelativePath(paths.configRoot, "projectPaths.configRoot");
  assertRelativePath(paths.modelsFile, "projectPaths.modelsFile");
  assertRelativePath(paths.skillManifestFile, "projectPaths.skillManifestFile");

  const policy = value.policyArgv;
  if (!isRecord(policy)) throw new TypeError("policyArgv must be an object");
  assertAllowedKeys(policy, ["gate", "dispatch"], "policyArgv");
  for (const name of ["gate", "dispatch"] as const) {
    const command = policy[name];
    if (!isRecord(command)) throw new TypeError(`policyArgv.${name} must be an object`);
    assertAllowedKeys(command, ["script", "argv"], `policyArgv.${name}`);
    assertRelativePath(command.script, `policyArgv.${name}.script`);
    assertArgv(command.argv, `policyArgv.${name}.argv`);
  }

  if (!Array.isArray(value.skillRoots) || value.skillRoots.length === 0) {
    throw new TypeError("skillRoots must be a non-empty array");
  }
  value.skillRoots.forEach((root, index) => assertRelativePath(root, `skillRoots[${index}]`));

  const intents = value.lifecycleIntentArgv;
  if (!isRecord(intents)) throw new TypeError("lifecycleIntentArgv must be an object");
  assertAllowedKeys(intents, ["tabColor", "operatorStatus"], "lifecycleIntentArgv");
  assertLifecycleIntentArgv(intents.tabColor, "lifecycleIntentArgv.tabColor");
  assertLifecycleIntentArgv(intents.operatorStatus, "lifecycleIntentArgv.operatorStatus");

  const timeouts = value.timeouts;
  if (!isRecord(timeouts)) throw new TypeError("timeouts must be an object");
  assertAllowedKeys(timeouts, ["policyMs", "tabColorMs", "operatorStatusMs"], "timeouts");
  assertPositiveTimeout(timeouts.policyMs, "timeouts.policyMs");
  assertPositiveTimeout(timeouts.tabColorMs, "timeouts.tabColorMs");
  assertPositiveTimeout(timeouts.operatorStatusMs, "timeouts.operatorStatusMs");

  assertNonEmptyString(value.sessionIdEnv, "sessionIdEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.sessionIdEnv)) {
    throw new TypeError("sessionIdEnv must be a valid environment variable name");
  }
  assertNonEmptyString(value.modelProvider, "modelProvider");
  if (value.budgetContextEnv !== undefined) {
    assertNonEmptyString(value.budgetContextEnv, "budgetContextEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.budgetContextEnv)) {
      throw new TypeError("budgetContextEnv must be a valid environment variable name");
    }
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Validate and deeply freeze a project adapter before it crosses the runtime boundary. */
export function createProjectAdapterV1(input: ProjectAdapterV1Input): ProjectAdapterV1 {
  assertProjectAdapterShape(input);
  return deepFreeze(input) as ProjectAdapterV1;
}

/** Runtime-safe alias useful when the adapter originates in JSON or another untyped source. */
export function validateProjectAdapterV1(value: unknown): ProjectAdapterV1 {
  assertProjectAdapterShape(value);
  return deepFreeze(value) as ProjectAdapterV1;
}

/** Parse and validate a JSON-compatible adapter value. */
export const parseProjectAdapterV1 = validateProjectAdapterV1;

/** Expand the small set of runtime-owned placeholders in an adapter argv list. */
export function resolveProjectArgv(
  argv: readonly string[],
  values: { readonly cwd: string; readonly event?: string },
): string[] {
  return argv.map((argument) =>
    argument.replaceAll("{cwd}", values.cwd).replaceAll("{event}", values.event ?? ""),
  );
}

export function resolveProjectPath(cwd: string, relativePath: string): string {
  return join(cwd, relativePath);
}

/** Neutral defaults keep the runtime useful for projects that do not need a Gaia-specific adapter. */
export const DEFAULT_PROJECT_ADAPTER_V1 = createProjectAdapterV1({
  version: PROJECT_ADAPTER_VERSION,
  projectPaths: {
    stateRoot: ".harness/state",
    configRoot: "config",
    modelsFile: "models.json",
    skillManifestFile: "skills.json",
  },
  policyArgv: {
    gate: { script: "hooks/gate.py", argv: ["--project-dir", "{cwd}"] },
    dispatch: {
      script: "hooks/dispatch.py",
      argv: ["--event", "{event}", "--project-dir", "{cwd}"],
    },
  },
  skillRoots: [".skills"],
  lifecycleIntentArgv: {
    tabColor: ["true"],
    operatorStatus: ["true"],
  },
  timeouts: {
    policyMs: 30_000,
    tabColorMs: 5_000,
    operatorStatusMs: 10_000,
  },
  sessionIdEnv: "AGENT_SESSION_ID",
  modelProvider: "default",
  budgetContextEnv: "OUTPUT_BUDGET_CONTEXT_TOKENS",
});
