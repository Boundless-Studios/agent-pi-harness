// Pi harness parity PR 2 (docs/plans/evaluate-harness-shift.md Step 4).
//
// Resolves the active model id and context-window size for
// the lifecycle PostToolUse dispatch payload, which the response-budget
// policy reads to calibrate its
// checkpoint/urgent thresholds (PR 3535 review round 2 P1 finding D — the
// guard fell back to a 200,000-token window while the configured model runs at
// a smaller context window, firing its first checkpoint AFTER the model had already
// overflowed).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PROJECT_ADAPTER_V1,
  resolveProjectPath,
} from "../project-adapter.js";
import type { ProjectAdapterV1 } from "../project-adapter.js";

export interface ModelContext {
  readonly model?: string;
  readonly contextWindow?: number;
}

interface ModelsJsonModelEntry {
  readonly id?: unknown;
  readonly contextWindow?: unknown;
}

interface ModelsJsonProviderEntry {
  readonly models?: readonly ModelsJsonModelEntry[];
}

interface ModelsJsonFile {
  readonly providers?: Readonly<Record<string, ModelsJsonProviderEntry>>;
}

function isModelsJsonModelEntry(value: unknown): value is ModelsJsonModelEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.id === undefined || typeof record.id === "string") &&
    (record.contextWindow === undefined ||
      (typeof record.contextWindow === "number" &&
        Number.isFinite(record.contextWindow) &&
        record.contextWindow > 0))
  );
}

function isModelsJsonProviderEntry(value: unknown): value is ModelsJsonProviderEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const models = (value as Record<string, unknown>).models;
  return models === undefined || (Array.isArray(models) && models.every(isModelsJsonModelEntry));
}

function readModelsJson(path: string): ModelsJsonFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const providers = (parsed as Record<string, unknown>).providers;
    if (providers === undefined || typeof providers !== "object" || providers === null || Array.isArray(providers)) {
      return undefined;
    }
    if (!Object.values(providers).every(isModelsJsonProviderEntry)) return undefined;
    return { providers: providers as Readonly<Record<string, ModelsJsonProviderEntry>> };
  } catch {
    return undefined;
  }
}

/** Looks up `provider`'s model list in one `models.json`-shaped file,
 * preferring an exact `modelId` match and falling back to the provider's
 * first model when no exact id is available. */
function lookupModelsJson(path: string, provider: string, modelId: string): ModelContext {
  const models = readModelsJson(path)?.providers?.[provider]?.models ?? [];
  const match = (modelId && models.find((entry) => entry.id === modelId)) || models[0];
  const contextWindow = typeof match?.contextWindow === "number" ? match.contextWindow : undefined;
  const model = typeof match?.id === "string" ? match.id : undefined;
  return { model, contextWindow };
}

/**
 * `PI_LAUNCH_PROVIDER`/`PI_LAUNCH_MODEL` are the launch-path envs PR 3
 * introduces (docs/plans/evaluate-harness-shift.md); until they land this
 * defaults to the adapter's configured provider. Tries
 * `$PI_CODING_AGENT_DIR/models.json` (the file the launcher renders per
 * proxy port at activate) first, then falls back to the adapter's project
 * model file when the rendered agent-dir copy is
 * unavailable (e.g. a bare `pi` invocation outside the project launcher).
 */
function resolveFromEnvAndModelsJson(
  cwd: string,
  adapter: ProjectAdapterV1,
): ModelContext {
  const provider = process.env.PI_LAUNCH_PROVIDER || adapter.modelProvider;
  const modelId = process.env.PI_LAUNCH_MODEL || "";
  const agentDir = process.env.PI_CODING_AGENT_DIR;

  const candidates = [
    agentDir ? join(agentDir, "models.json") : undefined,
    join(resolveProjectPath(cwd, adapter.projectPaths.configRoot), adapter.projectPaths.modelsFile),
  ].filter((path): path is string => Boolean(path));

  for (const candidate of candidates) {
    const found = lookupModelsJson(candidate, provider, modelId);
    if (found.model !== undefined || found.contextWindow !== undefined) return found;
  }
  return {};
}

/**
 * Resolves `{model, contextWindow}` for the budget guard's payload keys.
 * Pi's `ExtensionContext` DOES expose both directly: `ctx.model?.id` (the
 * `Model<Api>` Pi is presently running — tracks a live `/model` switch
 * mid-session) and `ctx.getContextUsage()?.contextWindow` (a plain `number`
 * field on `ContextUsage`, declared locally in pi-coding-agent's own
 * `extensions/types.d.ts` — unlike `Model<Api>`'s generic shape, which
 * comes from the external `@earendil-works/pi-ai` package this repo does not
 * vendor). `getContextUsage()` can return `undefined` "right after
 * compaction, before next LLM response" per its own doc comment, so any gap
 * is filled from the launch-environment/models.json fallback below.
 */
export function resolveModelContext(
  cwd: string,
  ctx: ExtensionContext | undefined,
  adapter: ProjectAdapterV1 = DEFAULT_PROJECT_ADAPTER_V1,
): ModelContext {
  const fromRuntime: ModelContext = {
    model: ctx?.model?.id,
    contextWindow: ctx?.getContextUsage()?.contextWindow,
  };
  if (fromRuntime.model !== undefined && fromRuntime.contextWindow !== undefined) {
    return fromRuntime;
  }
  const fromFallback = resolveFromEnvAndModelsJson(cwd, adapter);
  return {
    model: fromRuntime.model ?? fromFallback.model,
    contextWindow: fromRuntime.contextWindow ?? fromFallback.contextWindow,
  };
}
