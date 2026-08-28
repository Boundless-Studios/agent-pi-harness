import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface ExportConditions {
  readonly default: string;
  readonly import: string;
  readonly types: string;
}

interface InstalledManifest {
  readonly name?: string;
  readonly exports?: Readonly<Record<string, ExportConditions>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

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

  const installedRoot = join(
    consumerRoot,
    "node_modules",
    "@boundless-studios",
    "agent-pi-harness",
  );
  const packageJson = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  ) as InstalledManifest;
  if (packageJson.name !== "@boundless-studios/agent-pi-harness") {
    throw new Error(`consumer installed unexpected package: ${packageJson.name ?? "<missing>"}`);
  }
  if (packageJson.dependencies?.["@earendil-works/pi-coding-agent"] !== undefined) {
    throw new Error("packed package bundles Pi instead of using the host peer");
  }
  if (packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "0.84.2") {
    throw new Error("packed package does not declare the exact supported Pi peer");
  }
  if (existsSync(join(installedRoot, "node_modules", "@earendil-works", "pi-coding-agent"))) {
    throw new Error("packed package installed a nested Pi runtime");
  }
  if (!existsSync(join(installedRoot, "LICENSE"))) {
    throw new Error("packed package is missing LICENSE");
  }

  const exportedEntries = Object.entries(packageJson.exports ?? {});
  if (exportedEntries.length === 0) throw new Error("packed package has no exports");
  const specifiers = exportedEntries.map(([subpath, conditions]) => {
    for (const [condition, target] of Object.entries(conditions)) {
      if (!["default", "import", "types"].includes(condition) || !target.startsWith("./")) {
        throw new Error(`invalid ${subpath} export condition ${condition}: ${target}`);
      }
      if (!existsSync(join(installedRoot, target))) {
        throw new Error(`packed package is missing ${subpath} ${condition} target ${target}`);
      }
    }
    return subpath === "." ? packageJson.name! : `${packageJson.name}${subpath.slice(1)}`;
  });

  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const specifiers = ${JSON.stringify(specifiers)};`,
        "const entries = await Promise.all(specifiers.map((specifier) => import(specifier)));",
        'if (entries.length !== specifiers.length) throw new Error("not every export imported");',
        'if (typeof entries[0].default !== "function") throw new Error("root export is not callable");',
        "let registrations = 0;",
        "entries[0].default({ on: () => { registrations += 1; } });",
        'if (registrations !== 0) throw new Error("root entry point activated without an adapter");',
      ].join("\n"),
    ],
    { cwd: consumerRoot, stdio: "inherit" },
  );

  const typeImports = specifiers
    .map((specifier, index) => `import * as entry${index} from ${JSON.stringify(specifier)};`)
    .join("\n");
  const typeUses = specifiers.map((_specifier, index) => `void entry${index};`).join("\n");
  writeFileSync(join(consumerRoot, "index.ts"), `${typeImports}\n${typeUses}\n`);
  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ["index.ts"],
    }),
  );
  execFileSync(
    join(repositoryRoot, "node_modules", ".bin", "tsc"),
    ["--project", "tsconfig.json"],
    { cwd: consumerRoot, stdio: "inherit" },
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
