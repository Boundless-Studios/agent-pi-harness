# Agent Pi Harness

`@boundless-studios/agent-pi-harness` is a portable runtime for Pi lifecycle,
policy, skills, and Python-hook integrations. Project-specific paths and
trusted commands are supplied through the frozen `ProjectAdapterV1` contract.
Loading an extension entry point without an adapter is inert; a project shim
must pass an adapter to activate policy.

```sh
npm install @boundless-studios/agent-pi-harness
```

The host project must provide the exact supported
`@earendil-works/pi-coding-agent@0.84.2` peer. Keeping Pi as a peer preserves a
single runtime and module identity across the host and these extensions.

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

The runtime originates from Gaia parent revision
`a6fafb8c4c^` (`198ca51c8775eef0942e494f3fce363f2edc8558`); the historical
provenance fixture in `test/fixtures/extraction-provenance.json` records that source
attribution. The package now owns its public exports and behavioral tests; it
does not pin evolving package sources to hashes from the extraction date.

Adapter argv values are trusted project configuration, not a command-sandbox
boundary. Validation enforces structure, non-empty arguments, control-character
rejection, and explicit executable resolution; projects remain responsible for
the commands they configure.
