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
  ) as { name?: string; exports?: Record<string, unknown> };
  if (packageJson.name !== "@boundless-studios/agent-pi-harness") {
    throw new Error(`consumer installed unexpected package: ${packageJson.name ?? "<missing>"}`);
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'const root = await import("@boundless-studios/agent-pi-harness");',
        'const adapter = await import("@boundless-studios/agent-pi-harness/project-adapter");',
        'if (typeof root.default !== "function") throw new Error("root export is not callable");',
        'if (typeof adapter.createProjectAdapterV1 !== "function") throw new Error("adapter export missing");',
      ].join("\n"),
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
