import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

interface SourceNormalization {
  readonly from: string;
  readonly to: string;
}

interface HistoricalModule {
  readonly historicalPath: string;
  readonly extractedPath: string;
  readonly historicalSha256: string;
  readonly extractedSha256: string;
  readonly normalizations: readonly SourceNormalization[];
}

interface HistoricalParityFixture {
  readonly sourceRepository: string;
  readonly sourceCommitExpression: string;
  readonly sourceCommit: string;
  readonly modules: readonly HistoricalModule[];
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/historical-parity.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as HistoricalParityFixture;

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf-8").digest("hex");
}

const expectedModules = [
  "src/lifecycle.ts",
  "src/skills.ts",
  "src/warden.ts",
  "src/lib/dispatch.ts",
  "src/lib/model-context.ts",
  "src/lib/session.ts",
  "src/run-python.ts",
];

test("historical parity fixture enumerates every extracted module", () => {
  assert.equal(fixture.sourceCommitExpression, "a6fafb8c4c^");
  assert.equal(fixture.sourceCommit.length, 40);
  assert.deepEqual(
    fixture.modules.map((module) => module.extractedPath).sort(),
    [...expectedModules].sort(),
  );
});

for (const module of fixture.modules) {
  test(`historical source parity: ${module.extractedPath}`, () => {
    const source = readFileSync(join(repositoryRoot, module.extractedPath), "utf-8");
    assert.equal(sha256(source), module.extractedSha256);

    let historicalEquivalent = source;
    for (const normalization of module.normalizations) {
      assert.notEqual(
        historicalEquivalent.indexOf(normalization.from),
        -1,
        `${module.extractedPath} normalization did not match`,
      );
      historicalEquivalent = historicalEquivalent.split(normalization.from).join(normalization.to);
    }
    assert.equal(sha256(historicalEquivalent), module.historicalSha256);
  });
}
