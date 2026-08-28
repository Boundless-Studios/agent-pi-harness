import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-pi-harness-git-consumer-"));
const consumerRoot = join(temporaryRoot, "consumer");
mkdirSync(consumerRoot);

try {
  execFileSync("npm", ["init", "--yes"], { cwd: consumerRoot, stdio: "ignore" });
  const gitDependency = `git+${pathToFileURL(repositoryRoot).href}#HEAD`;
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefer-offline",
      gitDependency,
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );

  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@boundless-studios",
    "agent-pi-harness",
  );
  const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
    exports?: Record<string, Record<string, string>>;
  };
  for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
    for (const [condition, target] of Object.entries(conditions)) {
      if (!existsSync(join(installedRoot, target))) {
        throw new Error(`git dependency is missing ${subpath} ${condition} target ${target}`);
      }
    }
  }
  if (existsSync(join(installedRoot, "node_modules"))) {
    throw new Error("git dependency retained build-only or nested runtime dependencies");
  }
  await import("@boundless-studios/agent-pi-harness");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
