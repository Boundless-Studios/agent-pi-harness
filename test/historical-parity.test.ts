import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

interface HistoricalModule {
  readonly historicalPath: string;
  readonly extractedPath: string;
  readonly historicalSha256: string;
  readonly expectedExports: readonly string[];
}

interface HistoricalParityFixture {
  readonly sourceRepository: string;
  readonly sourceCommitExpression: string;
  readonly sourceCommit: string;
  readonly modules: readonly HistoricalModule[];
}

interface PackageManifest {
  readonly exports: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/historical-parity.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as HistoricalParityFixture;
const packageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
) as PackageManifest;

const immutableProvenance = {
  sourceRepository: "https://github.com/Boundless-Studios/gaia-free",
  sourceCommitExpression: "a6fafb8c4c^",
  sourceCommit: "198ca51c8775eef0942e494f3fce363f2edc8558",
  modules: [
    [".pi/extensions/gaia-lifecycle.ts", "src/lifecycle.ts", "c68a2b5da58f0f9b8a40c1680d7b7496c8307e640cfc764431c8d028c5aad9cf"],
    [".pi/extensions/gaia-skills.ts", "src/skills.ts", "22f91551ca7e723763ce14e44f5790a9bf149bdc74d897a0393bcfe0205f79df"],
    [".pi/extensions/gaia-warden.ts", "src/warden.ts", "48c9a561efedbe052435fc1f3fe662a19346b37099b2f59d86a71c7f077667bb"],
    [".pi/extensions/lib/dispatch.ts", "src/lib/dispatch.ts", "fd765e5165963daec34b58ce8091d57d38478febd38a0bfcfa81bd0df3a58888"],
    [".pi/extensions/lib/model-context.ts", "src/lib/model-context.ts", "651ccdd0ee5a17364345991c47e565a7ca3239a2940dc3833bb9ba8e2f837b00"],
    [".pi/extensions/lib/session.ts", "src/lib/session.ts", "6bcfd4cfde3011fd08f21de3050e3a762e014bf18fe6b3c5fc2078adad421969"],
    ["packages/pi-governance/src/run-python.ts", "src/run-python.ts", "c15aa8ab04625ceb8ba1e206a3b9efcad5177c5cad22938a6d5f5b44427cf813"],
  ],
} as const;

const publicSubpathBySource = new Map([
  ["src/lifecycle.ts", "./lifecycle"],
  ["src/skills.ts", "./skills"],
  ["src/warden.ts", "./warden"],
  ["src/lib/dispatch.ts", "./lib/dispatch"],
  ["src/lib/model-context.ts", "./lib/model-context"],
  ["src/lib/session.ts", "./lib/session"],
  ["src/run-python.ts", "./run-python"],
]);

test("extraction provenance remains pinned to the immutable Gaia source revision", () => {
  assert.equal(fixture.sourceRepository, immutableProvenance.sourceRepository);
  assert.equal(fixture.sourceCommitExpression, immutableProvenance.sourceCommitExpression);
  assert.equal(fixture.sourceCommit, immutableProvenance.sourceCommit);
  assert.deepEqual(
    fixture.modules.map(({ historicalPath, extractedPath, historicalSha256 }) => [
      historicalPath,
      extractedPath,
      historicalSha256,
    ]),
    immutableProvenance.modules,
  );
  for (const module of fixture.modules) {
    assert.deepEqual(
      Object.keys(module).sort(),
      ["expectedExports", "extractedPath", "historicalPath", "historicalSha256"].sort(),
    );
  }
});

for (const module of fixture.modules) {
  test(`public contract ownership: ${module.extractedPath}`, async () => {
    const packageSubpath = publicSubpathBySource.get(module.extractedPath);
    assert.ok(packageSubpath, `${module.extractedPath} has no package subpath`);
    assert.ok(packageSubpath in packageManifest.exports, `${packageSubpath} is not exported`);

    const loaded = await import(pathToFileURL(`${repositoryRoot}${module.extractedPath}`).href);
    for (const exportName of module.expectedExports) {
      assert.ok(exportName in loaded, `${module.extractedPath} is missing ${exportName}`);
    }
  });
}

test("the package root owns the lifecycle extension entry point", async () => {
  assert.ok("." in packageManifest.exports);
  const lifecycle = await import("../src/lifecycle.js");
  assert.equal(typeof lifecycle.default, "function");
});

test("Pi is an exact peer contract without a bundled runtime copy", () => {
  assert.equal(packageManifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(packageManifest.peerDependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(packageManifest.devDependencies["@earendil-works/pi-coding-agent"], "0.84.2");
});

test("public runtime sources do not claim Gaia-owned integration identities", () => {
  for (const module of fixture.modules) {
    const source = readFileSync(`${repositoryRoot}${module.extractedPath}`, "utf-8");
    assert.doesNotMatch(source, /gaia/i, `${module.extractedPath} contains project branding`);
  }
  const adapterSource = readFileSync(`${repositoryRoot}src/project-adapter.ts`, "utf-8");
  assert.doesNotMatch(adapterSource, /gaia/i, "src/project-adapter.ts contains project branding");
});
