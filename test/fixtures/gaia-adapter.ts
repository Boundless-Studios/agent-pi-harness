import { createProjectAdapterV1 } from "../../src/project-adapter.js";

export const GAIA_FIXTURE_ADAPTER = createProjectAdapterV1({
  version: 1,
  projectPaths: {
    stateRoot: ".gaia/pi-finalization",
    configRoot: "config",
    modelsFile: "pi-local-models.json",
    skillManifestFile: "pi-skills-compat.json"
  },
  policyArgv: {
    gate: {
      script: "scripts/pi-hooks/gate.py",
      argv: ["--project-dir", "{cwd}"]
    },
    dispatch: {
      script: "scripts/pi-hooks/dispatch.py",
      argv: ["--event", "{event}", "--project-dir", "{cwd}"]
    }
  },
  skillRoots: [".claude/skills"],
  lifecycleIntentArgv: {
    tabColor: ["python3", "scripts/codex-hooks/run_iterm_tab_color.py"],
    operatorStatus: ["gh", "pr", "view", "--json", "url,reviewDecision,statusCheckRollup"]
  },
  timeouts: {
    policyMs: 30_000,
    tabColorMs: 5_000,
    operatorStatusMs: 10_000
  },
  sessionIdEnv: "GAIA_SESSION_ID",
  modelProvider: "gaia-llama",
  budgetContextEnv: "GAIA_OUTPUT_BUDGET_CONTEXT_TOKENS"
});
