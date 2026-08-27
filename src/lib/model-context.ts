// Pi harness parity PR 2 (docs/plans/evaluate-harness-shift.md Step 4).
//
// Resolves the active model id and context-window size for
// gaia-lifecycle.ts's PostToolUse dispatch payload, which
// `.claude/hooks/response-budget-guard.py` reads to calibrate its
// checkpoint/urgent thresholds (PR 3535 review round 2 P1 finding D — the
// guard fell back to a 200,000-token window while gaia-llama runs at
// 65,536, firing its first checkpoint AFTER the model had already
// overflowed).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function readModelsJson(path: string): ModelsJsonFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as ModelsJsonFile) : undefined;
  } catch {
    return undefined;
  }
}

/** Looks up `provider`'s model list in one `models.json`-shaped file,
 * preferring an exact `modelId` match and falling back to the provider's
 * first model (gaia-llama's own config carries exactly one today). */
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
 * defaults to gaia-llama's repo-configured single model. Tries
 * `$PI_CODING_AGENT_DIR/models.json` (the file the launcher renders per
 * proxy port at activate) first, then falls back to the repo's own
 * `config/pi-local-models.json` when the rendered agent-dir copy is
 * unavailable (e.g. a bare `pi` invocation outside the Gaia launcher).
 */
function resolveFromEnvAndModelsJson(cwd: string): ModelContext {
  const provider = process.env.PI_LAUNCH_PROVIDER || "gaia-llama";
  const modelId = process.env.PI_LAUNCH_MODEL || "";
  const agentDir = process.env.PI_CODING_AGENT_DIR;

  const candidates = [
    agentDir ? join(agentDir, "models.json") : undefined,
    join(cwd, "config", "pi-local-models.json"),
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
export function resolveModelContext(cwd: string, ctx: ExtensionContext | undefined): ModelContext {
  const fromRuntime: ModelContext = {
    model: ctx?.model?.id,
    contextWindow: ctx?.getContextUsage()?.contextWindow,
  };
  if (fromRuntime.model !== undefined && fromRuntime.contextWindow !== undefined) {
    return fromRuntime;
  }
  const fromFallback = resolveFromEnvAndModelsJson(cwd);
  return {
    model: fromRuntime.model ?? fromFallback.model,
    contextWindow: fromRuntime.contextWindow ?? fromFallback.contextWindow,
  };
}
