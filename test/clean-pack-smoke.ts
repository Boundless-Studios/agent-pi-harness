import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-pi-harness-clean-pack-"));
const checkoutRoot = join(temporaryRoot, "checkout");

try {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repositoryRoot, checkoutRoot]);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: checkoutRoot,
    stdio: "inherit",
  });
  rmSync(join(checkoutRoot, "dist"), { recursive: true, force: true });
  if (existsSync(join(checkoutRoot, "dist"))) throw new Error("clean pack fixture retained dist");

  const tarballName = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", temporaryRoot],
    { cwd: checkoutRoot, encoding: "utf8" },
  ).trim();
  const tarball = join(temporaryRoot, tarballName);
  const contents = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).split("\n");
  for (const required of ["package/dist/lifecycle.js", "package/dist/lifecycle.d.ts"]) {
    if (!contents.includes(required)) throw new Error(`clean pack is missing ${required}`);
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
