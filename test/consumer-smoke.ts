import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-pi-harness-consumer-"));
const consumerRoot = join(temporaryRoot, "consumer");
mkdirSync(consumerRoot);

try {
  const packagePath = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", temporaryRoot],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  if (!packagePath) throw new Error("npm pack did not return a tarball path");
  const tarball = packagePath.startsWith("/") ? packagePath : join(temporaryRoot, packagePath);
  if (!existsSync(tarball)) throw new Error(`npm pack output does not exist: ${tarball}`);

  execFileSync("npm", ["init", "--yes"], { cwd: consumerRoot, stdio: "ignore" });
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefer-offline",
      tarball,
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );
  const packageJson = JSON.parse(
    readFileSync(join(consumerRoot, "node_modules", "@boundless-studios", "agent-pi-harness", "package.json"), "utf8"),
  ) as {
    name?: string;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (packageJson.name !== "@boundless-studios/agent-pi-harness") {
    throw new Error(`consumer installed unexpected package: ${packageJson.name ?? "<missing>"}`);
  }
  if (packageJson.dependencies?.["@earendil-works/pi-coding-agent"] !== undefined) {
    throw new Error("packed package bundles Pi instead of using the host peer");
  }
  if (packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "0.84.2") {
    throw new Error("packed package does not declare the exact supported Pi peer");
  }
  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@boundless-studios",
    "agent-pi-harness",
  );
  for (const artifact of [
    "dist/lifecycle.js",
    "dist/lifecycle.d.ts",
    "dist/project-adapter.js",
    "dist/project-adapter.d.ts",
    "dist/lib/dispatch.js",
    "dist/lib/dispatch.d.ts",
  ]) {
    if (!existsSync(join(installedRoot, artifact))) {
      throw new Error(`packed package is missing ${artifact}`);
    }
  }
  if (existsSync(join(installedRoot, "node_modules", "@earendil-works", "pi-coding-agent"))) {
    throw new Error("packed package installed a nested Pi runtime");
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'const root = await import("@boundless-studios/agent-pi-harness");',
        'const lifecycle = await import("@boundless-studios/agent-pi-harness/lifecycle");',
        'const skills = await import("@boundless-studios/agent-pi-harness/skills");',
        'const warden = await import("@boundless-studios/agent-pi-harness/warden");',
        'const dispatch = await import("@boundless-studios/agent-pi-harness/lib/dispatch");',
        'const modelContext = await import("@boundless-studios/agent-pi-harness/lib/model-context");',
        'const session = await import("@boundless-studios/agent-pi-harness/lib/session");',
        'const adapter = await import("@boundless-studios/agent-pi-harness/project-adapter");',
        'const python = await import("@boundless-studios/agent-pi-harness/run-python");',
        'if (typeof root.default !== "function") throw new Error("root export is not callable");',
        'if (root.default !== lifecycle.default) throw new Error("root and lifecycle entry points differ");',
        'if (typeof lifecycle.createLifecycleHandlers !== "function") throw new Error("lifecycle export missing");',
        'if (typeof skills.contributedSkillPaths !== "function") throw new Error("skills export missing");',
        'if (typeof warden.createWardenHandlers !== "function") throw new Error("warden export missing");',
        'if (typeof dispatch.collectAdvisoryText !== "function") throw new Error("dispatch export missing");',
        'if (typeof modelContext.resolveModelContext !== "function") throw new Error("model-context export missing");',
        'if (typeof session.resolveSessionId !== "function") throw new Error("session export missing");',
        'if (typeof adapter.createProjectAdapterV1 !== "function") throw new Error("adapter export missing");',
        'if (typeof python.runPython !== "function") throw new Error("run-python export missing");',
        'if (adapter.DEFAULT_PROJECT_ADAPTER_V1.modelProvider !== "default") throw new Error("neutral adapter missing");',
      ].join("\n"),
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
