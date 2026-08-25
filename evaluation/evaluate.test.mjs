import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  calculateSuiteDigest,
  checkRemoteUrlSafety,
  classifyHttpObservation,
  compareScorecards,
  evaluateSubject,
  extractLinks,
  loadSuite,
  probeUrl,
  readFileSubject,
  runEvaluation,
} from "./evaluate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const testSuiteDigest = `sha256:${"0".repeat(64)}`;

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function evaluateFixture(markdown) {
  const directory = await temporaryDirectory("readme-evaluator-fixture-");
  const readmePath = path.join(directory, "README.md");
  await writeFile(readmePath, markdown, "utf8");
  const suite = await loadSuite(repoRoot);
  const subject = await readFileSubject("candidate", readmePath, directory);
  return evaluateSubject(subject, {
    suite,
    suiteDigest: testSuiteDigest,
    remoteObservations: new Map(),
    repoRoot: directory,
  });
}

function check(scorecard, checkId) {
  const result = scorecard.checks.find((candidate) => candidate.check_id === checkId);
  assert.ok(result, `missing check ${checkId}`);
  return result;
}

function scorecardWithOutcomes(suite, role, outcomes) {
  const checks = suite.checks.map((definition) => ({
    check_id: definition.id,
    required: definition.required,
    outcome: outcomes[definition.id] ?? "pass",
    evidence_codes: ["test-observation"],
  }));
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const result of checks) counts[result.outcome] += 1;
  const outcome = checks.some((result) => result.required && result.outcome === "fail")
    ? "fail"
    : checks.some((result) => result.required && result.outcome === "unknown")
      ? "unknown"
      : "pass";
  return {
    schema_version: "readme-evaluation-scorecard.v1",
    suite: { suite_id: suite.suiteId, suite_digest: testSuiteDigest },
    subject: {
      role,
      kind: "file",
      source: "README.md",
      content_digest: testSuiteDigest,
    },
    checks,
    counts,
    outcome,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server, sockets = []) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

test("valid GFM blockquote produces a passing render check", async () => {
  const scorecard = await evaluateFixture("# Profile\n\n> Inspectable evaluation evidence.\n");

  assert.equal(check(scorecard, "gfm-render").outcome, "pass");
  assert.equal(scorecard.outcome, "pass");
});

test("empty Markdown produces a definitive render failure", async () => {
  const scorecard = await evaluateFixture("");

  assert.equal(check(scorecard, "gfm-render").outcome, "fail");
  assert.equal(scorecard.outcome, "fail");
});

test("missing relative link target produces a definitive failure", async () => {
  const scorecard = await evaluateFixture("# Profile\n\n[Missing](./does-not-exist.md)\n");

  assert.equal(check(scorecard, "relative-links").outcome, "fail");
  assert.ok(check(scorecard, "relative-links").evidence_codes.includes("relative-target-missing"));
});

test("raw HTML links retain the existing link-validation semantics", async () => {
  const scorecard = await evaluateFixture("# Profile\n\n<a href=\"./missing-from-html.md\">Missing</a>\n");

  assert.equal(check(scorecard, "relative-links").outcome, "fail");
  assert.ok(check(scorecard, "relative-links").evidence_codes.includes("relative-target-missing"));
});

test("live link safety rejects local and credential-bearing targets", async () => {
  assert.deepEqual(await checkRemoteUrlSafety("http://localhost/private"), {
    safe: false,
    errorCode: "address-denied",
  });
  assert.deepEqual(await checkRemoteUrlSafety("http://127.0.0.1/private"), {
    safe: false,
    errorCode: "address-denied",
  });
  assert.deepEqual(await checkRemoteUrlSafety("https://user:secret@example.com/private"), {
    safe: false,
    errorCode: "invalid-url",
  });
});

test("loopback HTTP 404 is classified as fail", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end("missing");
  });
  const baseUrl = await listen(server);
  try {
    const observation = await probeUrl(`${baseUrl}/missing`, { timeoutMs: 500 });
    assert.equal(classifyHttpObservation(observation, [200, 206, 999]).outcome, "fail");
  } finally {
    await closeServer(server);
  }
});

test("loopback HTTP timeout is classified as unknown", async () => {
  const sockets = [];
  const server = http.createServer(() => {});
  server.on("connection", (socket) => sockets.push(socket));
  const baseUrl = await listen(server);
  try {
    const observation = await probeUrl(`${baseUrl}/hang`, { timeoutMs: 30 });
    const classified = classifyHttpObservation(observation, [200, 206, 999]);
    assert.equal(classified.outcome, "unknown");
    assert.equal(classified.evidenceCode, "remote-timeout");
  } finally {
    await closeServer(server, sockets);
  }
});

test("baseline comparison classifies regressions and fixes", async () => {
  const suite = await loadSuite(repoRoot);
  const baselinePass = scorecardWithOutcomes(suite, "baseline", {});
  const candidateFail = scorecardWithOutcomes(suite, "candidate", { "gfm-render": "fail" });
  const regression = compareScorecards(baselinePass, candidateFail, suite);
  assert.equal(regression.outcome, "fail");
  assert.equal(regression.transitions[0].classification, "regression");

  const baselineFail = scorecardWithOutcomes(suite, "baseline", { "gfm-render": "fail" });
  const candidatePass = scorecardWithOutcomes(suite, "candidate", {});
  const fixed = compareScorecards(baselineFail, candidatePass, suite);
  assert.equal(fixed.outcome, "pass");
  assert.equal(fixed.transitions[0].classification, "fixed");
});

test("inherited candidate failure remains a failed gate", async () => {
  const suite = await loadSuite(repoRoot);
  const baseline = scorecardWithOutcomes(suite, "baseline", { "relative-links": "fail" });
  const candidate = scorecardWithOutcomes(suite, "candidate", { "relative-links": "fail" });
  const comparison = compareScorecards(baseline, candidate, suite);

  assert.equal(comparison.outcome, "fail");
  assert.equal(comparison.transitions[1].classification, "unchanged-fail");
});

test("required unknown produces an explicit unknown gate", async () => {
  const suite = await loadSuite(repoRoot);
  const baseline = scorecardWithOutcomes(suite, "baseline", {});
  const candidate = scorecardWithOutcomes(suite, "candidate", { "remote-links": "unknown" });
  const comparison = compareScorecards(baseline, candidate, suite);

  assert.equal(comparison.outcome, "unknown");
  assert.equal(comparison.transitions[2].classification, "indeterminate");
});

test("suite digest changes when an identity input changes", async () => {
  const directory = await temporaryDirectory("readme-suite-identity-");
  await writeFile(path.join(directory, "a"), "alpha", "utf8");
  await writeFile(path.join(directory, "b"), "bravo", "utf8");
  const before = await calculateSuiteDigest(directory, ["a", "b"]);
  await writeFile(path.join(directory, "b"), "changed", "utf8");
  const afterDigest = await calculateSuiteDigest(directory, ["a", "b"]);

  assert.match(before, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(before, afterDigest);
});

test("CLI preserves distinct pass, fail, unknown, and usage exit codes", async () => {
  const directory = await temporaryDirectory("readme-cli-outcomes-");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const markdown = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const fixtures = Object.fromEntries(
    extractLinks(markdown)
      .filter((link) => /^https?:\/\//u.test(link))
      .map((link) => [link, { statusCode: 200 }]),
  );
  const fixturePath = path.join(directory, "links.json");
  const badCandidatePath = path.join(directory, "README.md");
  await writeFile(fixturePath, JSON.stringify(fixtures), "utf8");
  await writeFile(badCandidatePath, "# Broken\n\n[Missing](./missing.md)\n", "utf8");
  const evaluatorPath = path.join(repoRoot, "evaluation/evaluate.mjs");
  const run = (argumentsList) => spawnSync(process.execPath, [evaluatorPath, ...argumentsList], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const common = ["--baseline", head, "--network", "fixture", "--fixture", fixturePath];

  const passed = run([...common, "--candidate", "README.md", "--out", path.join(directory, "pass")]);
  assert.equal(passed.status, 0, passed.stderr);
  const failed = run([...common, "--candidate", badCandidatePath, "--out", path.join(directory, "fail")]);
  assert.equal(failed.status, 1, failed.stderr);
  const unknown = run([
    "--baseline", head,
    "--candidate", "README.md",
    "--network", "deny",
    "--out", path.join(directory, "unknown"),
  ]);
  assert.equal(unknown.status, 2, unknown.stderr);
  const invalid = run([]);
  assert.equal(invalid.status, 64, invalid.stderr);
});

test("identical hermetic runs emit byte-identical schema-valid evidence", async () => {
  const outputRoot = await temporaryDirectory("readme-evidence-");
  const outputA = path.join(outputRoot, "a");
  const outputB = path.join(outputRoot, "b");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const markdown = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const fixtures = Object.fromEntries(
    extractLinks(markdown)
      .filter((link) => /^https?:\/\//u.test(link))
      .map((link) => [link, { statusCode: 200 }]),
  );
  const options = {
    repoRoot,
    baseline: head,
    candidate: "README.md",
    networkMode: "fixture",
    fixtures,
  };

  const runA = await runEvaluation({ ...options, outDir: outputA });
  const runB = await runEvaluation({ ...options, outDir: outputB });
  assert.equal(runA.exitCode, 0);
  assert.equal(runB.exitCode, 0);

  const evidencePaths = [
    "trace.jsonl",
    "scorecards/baseline.json",
    "scorecards/candidate.json",
    "comparison.json",
  ];
  for (const evidencePath of evidencePaths) {
    const [bytesA, bytesB] = await Promise.all([
      readFile(path.join(outputA, evidencePath)),
      readFile(path.join(outputB, evidencePath)),
    ]);
    assert.deepEqual(bytesA, bytesB, `${evidencePath} must be reproducible`);
  }

  const schema = JSON.parse(await readFile(path.join(repoRoot, "evaluation/evidence.schema.json"), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const traceEvents = (await readFile(path.join(outputA, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const documents = [
    ...traceEvents,
    JSON.parse(await readFile(path.join(outputA, "scorecards/baseline.json"), "utf8")),
    JSON.parse(await readFile(path.join(outputA, "scorecards/candidate.json"), "utf8")),
    JSON.parse(await readFile(path.join(outputA, "comparison.json"), "utf8")),
  ];
  for (const document of documents) {
    assert.equal(validate(document), true, JSON.stringify(validate.errors));
  }
});
