# Agent Pi Harness

`@boundless-studios/agent-pi-harness` is a portable runtime for Pi lifecycle,
policy, skills, and Python-hook integrations. Project-specific paths and
commands are supplied through the frozen `ProjectAdapterV1` contract.

```sh
npm install @boundless-studios/agent-pi-harness
```

The package exposes the lifecycle entry point at `.`, plus `./lifecycle`,
`./warden`, `./skills`, `./project-adapter`, `./run-python`, and the library
subpaths. A project can pass a validated adapter to the lifecycle, warden, and
skills entry points:

```ts
import lifecycle from "@boundless-studios/agent-pi-harness";
import { createProjectAdapterV1 } from "@boundless-studios/agent-pi-harness/project-adapter";

const adapter = createProjectAdapterV1({
  version: 1,
  projectPaths: {
    stateRoot: ".agent/state",
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
  timeouts: { policyMs: 30_000, tabColorMs: 5_000, operatorStatusMs: 10_000 },
  sessionIdEnv: "AGENT_SESSION_ID",
  modelProvider: "default",
});

lifecycle(pi, adapter);
```

For local development:

```sh
npm install
npm run typecheck
npm run build
npm test
npm run consumer-smoke
npm pack --dry-run
```

The runtime preserves the extracted behavior from Gaia parent revision
`a6fafb8c4c^` (`198ca51c8775eef0942e494f3fce363f2edc8558`); the historical
parity fixture in `test/fixtures/historical-parity.json` records that source
attribution and the exported-behavior checks.
