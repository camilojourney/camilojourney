import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { marked } from "marked";

const require = createRequire(import.meta.url);
const markdownLinkCheck = require("markdown-link-check");
const markdownLinkExtractor = require("markdown-link-extractor");

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const HTTP_LINK_PATTERN = /^https?:\/\//u;
const OUTCOME_EXIT_CODES = { pass: 0, fail: 1, unknown: 2 };
const SUITE_PATH = "evaluation/suite.v1.json";

class UsageError extends Error {}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function publicSubject(subject) {
  return {
    role: subject.role,
    kind: subject.kind,
    source: subject.source,
    ...(subject.commit ? { commit: subject.commit } : {}),
    content_digest: subject.content_digest,
  };
}

function checkOutcome(checks) {
  if (checks.some((check) => check.required && check.outcome === "fail")) return "fail";
  if (checks.some((check) => check.required && check.outcome === "unknown")) return "unknown";
  return "pass";
}

function countOutcomes(checks) {
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const check of checks) counts[check.outcome] += 1;
  return counts;
}

function makeCheck(definition, outcome, evidenceCodes) {
  return {
    check_id: definition.id,
    required: definition.required,
    outcome,
    evidence_codes: uniqueSorted(evidenceCodes),
  };
}

function collectHeadings(tokens) {
  const headings = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type === "heading" && typeof token.text === "string") headings.push(token.text);
  });
  return headings;
}

function githubAnchor(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function headingAnchors(headings) {
  const counts = new Map();
  return new Set(
    headings.map((heading) => {
      const base = githubAnchor(heading);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      return count === 0 ? base : `${base}-${count}`;
    }),
  );
}

function parseMarkdown(markdown) {
  const tokens = marked.lexer(markdown, { gfm: true });
  const rendered = marked.parser(tokens, { gfm: true });
  return {
    rendered,
    links: uniqueSorted(markdownLinkExtractor(markdown)),
    headings: collectHeadings(tokens),
  };
}

export function extractLinks(markdown) {
  try {
    return parseMarkdown(markdown).links;
  } catch {
    return [];
  }
}

export async function loadSuite(repoRoot) {
  const suite = JSON.parse(await readFile(path.join(repoRoot, SUITE_PATH), "utf8"));
  if (suite.schemaVersion !== "readme-evaluation-suite.v1" || !suite.suiteId) {
    throw new UsageError(`Invalid suite config at ${SUITE_PATH}`);
  }
  if (!Array.isArray(suite.identityInputs) || !Array.isArray(suite.checks)) {
    throw new UsageError(`Suite config must define identityInputs and checks`);
  }
  return suite;
}

export async function calculateSuiteDigest(repoRoot, identityInputs) {
  const hash = createHash("sha256");
  for (const input of [...identityInputs].sort(compareText)) {
    const bytes = await readFile(path.join(repoRoot, input));
    hash.update(input, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function relativeSource(filePath, repoRoot) {
  const relative = path.relative(repoRoot, filePath);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(filePath);
}

export async function readFileSubject(role, filePath, repoRoot) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const markdown = await readFile(absolutePath, "utf8");
  return {
    role,
    kind: "file",
    source: relativeSource(absolutePath, repoRoot),
    content_digest: sha256(markdown),
    markdown,
    filePath: absolutePath,
  };
}

function runGit(repoRoot, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function readGitSubject(role, commit, repoRoot) {
  if (!FULL_COMMIT_PATTERN.test(commit)) {
    throw new UsageError(`${role} Git subject must be an explicit full commit SHA`);
  }
  const resolved = runGit(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  if (resolved !== commit) throw new UsageError(`${role} commit did not resolve exactly: ${commit}`);
  const markdown = runGit(repoRoot, ["show", `${commit}:README.md`]);
  return {
    role,
    kind: "git",
    source: "README.md",
    commit,
    content_digest: sha256(markdown),
    markdown,
  };
}

function normalizedRelativeTarget(href) {
  const withoutFragment = href.split("#", 1)[0].split("?", 1)[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

async function relativeTargetExists(subject, href, repoRoot) {
  const target = normalizedRelativeTarget(href);
  if (!target) return true;
  if (path.isAbsolute(target)) return false;
  const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) return false;
  if (subject.kind === "git") {
    try {
      runGit(repoRoot, ["cat-file", "-e", `${subject.commit}:${normalized}`]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await access(path.resolve(path.dirname(subject.filePath), target));
    return true;
  } catch {
    return false;
  }
}

function isIgnored(link, ignorePatterns) {
  return ignorePatterns.some(({ pattern }) => new RegExp(pattern, "u").test(link));
}

export function classifyHttpObservation(observation, aliveStatusCodes) {
  if (!observation) return { outcome: "unknown", evidenceCode: "remote-observation-missing" };
  if (observation.errorCode === "timeout") {
    return { outcome: "unknown", evidenceCode: "remote-timeout" };
  }
  if (observation.errorCode) {
    return { outcome: "unknown", evidenceCode: "remote-transport-error" };
  }
  const statusCode = Number(observation.statusCode ?? 0);
  if (aliveStatusCodes.includes(statusCode)) {
    return { outcome: "pass", evidenceCode: `remote-status-${statusCode}` };
  }
  if (statusCode === 0 || statusCode === 429 || statusCode >= 500) {
    return { outcome: "unknown", evidenceCode: statusCode ? `remote-status-${statusCode}` : "remote-transport-error" };
  }
  return { outcome: "fail", evidenceCode: `remote-status-${statusCode}` };
}

export async function probeUrl(url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return { statusCode: response.status };
  } catch (error) {
    if (error?.name === "AbortError") return { errorCode: "timeout" };
    return { errorCode: "transport" };
  } finally {
    clearTimeout(timeout);
  }
}

function fixtureObservation(value) {
  if (typeof value === "number") return { statusCode: value };
  if (value && typeof value === "object") return value;
  return { errorCode: "fixture-missing" };
}

function diagnosticUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19));
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice("::ffff:".length));
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized)
      || normalized.startsWith("ff");
  }
  return true;
}

export async function checkRemoteUrlSafety(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, errorCode: "invalid-url" };
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    return { safe: false, errorCode: "invalid-url" };
  }
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    return { safe: false, errorCode: "address-denied" };
  }
  try {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      return { safe: false, errorCode: "address-denied" };
    }
    return { safe: true };
  } catch {
    return { safe: false, errorCode: "dns" };
  }
}

function runMarkdownLinkCheck(urls, linkPolicy) {
  if (urls.length === 0) return Promise.resolve(new Map());
  const markdown = urls.map((url) => `<${url}>`).join("\n");
  const options = {
    ignorePatterns: linkPolicy.ignorePatterns,
    retryOn429: linkPolicy.retryOn429,
    retryCount: linkPolicy.retryCount,
    fallbackRetryDelay: linkPolicy.fallbackRetryDelay,
    timeout: linkPolicy.timeout,
    aliveStatusCodes: linkPolicy.aliveStatusCodes,
  };
  return new Promise((resolve) => {
    markdownLinkCheck(markdown, options, (error, results = []) => {
      if (error) {
        resolve(new Map(urls.map((url) => [url, { errorCode: "transport" }])));
        return;
      }
      const observations = new Map();
      for (const result of results) {
        observations.set(result.link, result.err
          ? { errorCode: result.err.code === "ETIMEDOUT" ? "timeout" : "transport" }
          : { statusCode: result.statusCode });
      }
      for (const url of urls) {
        if (!observations.has(url)) observations.set(url, { errorCode: "transport" });
      }
      resolve(observations);
    });
  });
}

async function observeRemoteLinks(urls, suite, networkMode, fixtures) {
  const ignored = new Set(urls.filter((url) => isIgnored(url, suite.linkPolicy.ignorePatterns)));
  const checkable = urls.filter((url) => !ignored.has(url));
  const observations = new Map([...ignored].map((url) => [url, { ignored: true }]));
  if (networkMode === "deny") {
    for (const url of checkable) observations.set(url, { errorCode: "network-denied" });
    return observations;
  }
  if (networkMode === "fixture") {
    for (const url of checkable) observations.set(url, fixtureObservation(fixtures?.[url]));
    return observations;
  }
  if (networkMode === "live") {
    const safetyResults = await Promise.all(checkable.map(async (url) => [url, await checkRemoteUrlSafety(url)]));
    const safeUrls = [];
    for (const [url, safety] of safetyResults) {
      if (safety.safe) safeUrls.push(url);
      else observations.set(url, { errorCode: safety.errorCode });
    }
    const live = await runMarkdownLinkCheck(safeUrls, suite.linkPolicy);
    for (const [url, observation] of live) observations.set(url, observation);
    for (const url of checkable) {
      const observation = observations.get(url);
      const classified = classifyHttpObservation(observation, suite.linkPolicy.aliveStatusCodes);
      console.log(`Remote link: ${diagnosticUrl(url)} ${classified.outcome} (${classified.evidenceCode})`);
    }
    return observations;
  }
  throw new UsageError(`Unsupported network mode: ${networkMode}`);
}

async function evaluateRelativeLinks(subject, links, headings, repoRoot) {
  const anchors = headingAnchors(headings);
  const relativeLinks = links.filter((link) => !HTTP_LINK_PATTERN.test(link) && !link.startsWith("mailto:"));
  const evidenceCodes = [];
  for (const link of relativeLinks) {
    if (link.startsWith("#")) {
      const anchor = link.slice(1);
      if (!anchors.has(anchor)) evidenceCodes.push("relative-anchor-missing");
    } else if (!(await relativeTargetExists(subject, link, repoRoot))) {
      evidenceCodes.push("relative-target-missing");
    }
  }
  if (relativeLinks.length === 0) return { outcome: "pass", evidenceCodes: ["no-relative-links"] };
  if (evidenceCodes.length > 0) return { outcome: "fail", evidenceCodes };
  return { outcome: "pass", evidenceCodes: ["relative-targets-resolved"] };
}

function evaluateRemoteLinks(links, suite, remoteObservations) {
  const remoteLinks = links.filter((link) => HTTP_LINK_PATTERN.test(link));
  if (remoteLinks.length === 0) return { outcome: "pass", evidenceCodes: ["no-remote-links"] };
  const classified = [];
  for (const link of remoteLinks) {
    const observation = remoteObservations.get(link);
    if (observation?.ignored) {
      classified.push({ outcome: "pass", evidenceCode: "remote-link-ignored" });
    } else if (observation?.errorCode === "network-denied") {
      classified.push({ outcome: "unknown", evidenceCode: "remote-network-denied" });
    } else if (observation?.errorCode === "fixture-missing") {
      classified.push({ outcome: "unknown", evidenceCode: "remote-fixture-missing" });
    } else if (observation?.errorCode === "address-denied" || observation?.errorCode === "invalid-url") {
      classified.push({ outcome: "unknown", evidenceCode: "remote-address-denied" });
    } else if (observation?.errorCode === "dns") {
      classified.push({ outcome: "unknown", evidenceCode: "remote-dns-error" });
    } else {
      classified.push(classifyHttpObservation(observation, suite.linkPolicy.aliveStatusCodes));
    }
  }
  const outcome = classified.some((result) => result.outcome === "fail")
    ? "fail"
    : classified.some((result) => result.outcome === "unknown")
      ? "unknown"
      : "pass";
  return { outcome, evidenceCodes: classified.map((result) => result.evidenceCode) };
}

export async function evaluateSubject(subject, { suite, suiteDigest, remoteObservations, repoRoot }) {
  let parsed;
  let renderResult;
  try {
    parsed = parseMarkdown(subject.markdown);
    renderResult = parsed.rendered.trim()
      ? { outcome: "pass", evidenceCodes: ["gfm-render-nonempty"] }
      : { outcome: "fail", evidenceCodes: ["gfm-render-empty"] };
  } catch {
    parsed = { links: [], headings: [] };
    renderResult = { outcome: "fail", evidenceCodes: ["gfm-render-error"] };
  }
  const relativeResult = await evaluateRelativeLinks(subject, parsed.links, parsed.headings, repoRoot);
  const remoteResult = evaluateRemoteLinks(parsed.links, suite, remoteObservations);
  const results = new Map([
    ["gfm-render", renderResult],
    ["relative-links", relativeResult],
    ["remote-links", remoteResult],
  ]);
  const checks = suite.checks.map((definition) => {
    const result = results.get(definition.id);
    if (!result) throw new UsageError(`No evaluator implementation for suite check: ${definition.id}`);
    return makeCheck(definition, result.outcome, result.evidenceCodes);
  });
  return {
    schema_version: "readme-evaluation-scorecard.v1",
    suite: { suite_id: suite.suiteId, suite_digest: suiteDigest },
    subject: publicSubject(subject),
    checks,
    counts: countOutcomes(checks),
    outcome: checkOutcome(checks),
  };
}

function transitionClassification(baselineOutcome, candidateOutcome) {
  if (baselineOutcome === "pass" && candidateOutcome === "pass") return "unchanged-pass";
  if (baselineOutcome === "pass" && candidateOutcome === "fail") return "regression";
  if (baselineOutcome === "fail" && candidateOutcome === "pass") return "fixed";
  if (baselineOutcome === "fail" && candidateOutcome === "fail") return "unchanged-fail";
  return "indeterminate";
}

export function compareScorecards(baseline, candidate, suite) {
  const transitions = suite.checks.map((definition) => {
    const baselineCheck = baseline.checks.find((check) => check.check_id === definition.id);
    const candidateCheck = candidate.checks.find((check) => check.check_id === definition.id);
    if (!baselineCheck || !candidateCheck) throw new UsageError(`Scorecard is missing suite check: ${definition.id}`);
    return {
      check_id: definition.id,
      required: definition.required,
      baseline_outcome: baselineCheck.outcome,
      candidate_outcome: candidateCheck.outcome,
      classification: transitionClassification(baselineCheck.outcome, candidateCheck.outcome),
    };
  });
  const outcome = transitions.some((transition) => transition.required && transition.candidate_outcome === "fail")
    ? "fail"
    : transitions.some(
      (transition) => transition.required
        && (transition.baseline_outcome === "unknown" || transition.candidate_outcome === "unknown"),
    )
      ? "unknown"
      : "pass";
  return {
    schema_version: "readme-evaluation-comparison.v1",
    suite: baseline.suite,
    baseline: baseline.subject,
    candidate: candidate.subject,
    transitions,
    outcome,
  };
}

function traceEvents(scorecards) {
  return scorecards.flatMap((scorecard) => scorecard.checks.map((check) => ({
    schema_version: "readme-evaluation-trace.v1",
    suite: scorecard.suite,
    subject: scorecard.subject,
    check_id: check.check_id,
    outcome: check.outcome,
    evidence_codes: check.evidence_codes,
  })));
}

async function writeEvidence(outDir, baselineScorecard, candidateScorecard, comparison) {
  await mkdir(path.join(outDir, "scorecards"), { recursive: true });
  const trace = traceEvents([baselineScorecard, candidateScorecard]);
  await Promise.all([
    writeFile(path.join(outDir, "trace.jsonl"), `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"),
    writeFile(path.join(outDir, "scorecards/baseline.json"), json(baselineScorecard), "utf8"),
    writeFile(path.join(outDir, "scorecards/candidate.json"), json(candidateScorecard), "utf8"),
    writeFile(path.join(outDir, "comparison.json"), json(comparison), "utf8"),
  ]);
}

export async function runEvaluation({
  repoRoot,
  baseline,
  candidate,
  outDir,
  networkMode,
  fixtures,
}) {
  if (!repoRoot || !baseline || !candidate || !outDir || !networkMode) {
    throw new UsageError("repoRoot, baseline, candidate, outDir, and networkMode are required");
  }
  const suite = await loadSuite(repoRoot);
  const suiteDigest = await calculateSuiteDigest(repoRoot, suite.identityInputs);
  const baselineSubject = await readGitSubject("baseline", baseline, repoRoot);
  const candidateSubject = FULL_COMMIT_PATTERN.test(candidate)
    ? await readGitSubject("candidate", candidate, repoRoot)
    : await readFileSubject("candidate", candidate, repoRoot);
  const remoteLinks = uniqueSorted([
    ...extractLinks(baselineSubject.markdown),
    ...extractLinks(candidateSubject.markdown),
  ].filter((link) => HTTP_LINK_PATTERN.test(link)));
  const remoteObservations = await observeRemoteLinks(remoteLinks, suite, networkMode, fixtures);
  const evaluationOptions = { suite, suiteDigest, remoteObservations, repoRoot };
  const baselineScorecard = await evaluateSubject(baselineSubject, evaluationOptions);
  const candidateScorecard = await evaluateSubject(candidateSubject, evaluationOptions);
  const comparison = compareScorecards(baselineScorecard, candidateScorecard, suite);
  await writeEvidence(outDir, baselineScorecard, candidateScorecard, comparison);
  return {
    baselineScorecard,
    candidateScorecard,
    comparison,
    exitCode: OUTCOME_EXIT_CODES[comparison.outcome],
  };
}

function usage() {
  return [
    "Usage: npm run evaluate -- --baseline <full-sha> --candidate <full-sha-or-path>",
    "  --network <live|deny|fixture> --out <directory> [--fixture <json-file>]",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) throw new UsageError(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.baseline || !options.candidate || !options.network || !options.out) {
    throw new UsageError(usage());
  }
  if (options.network === "fixture" && !options.fixture) {
    throw new UsageError("--fixture is required when --network fixture is selected");
  }
  const repoRoot = process.cwd();
  const fixtures = options.fixture
    ? JSON.parse(await readFile(path.resolve(repoRoot, options.fixture), "utf8"))
    : undefined;
  const result = await runEvaluation({
    repoRoot,
    baseline: options.baseline,
    candidate: options.candidate,
    outDir: path.resolve(repoRoot, options.out),
    networkMode: options.network,
    fixtures,
  });
  console.log(`README evaluation: ${result.comparison.outcome}`);
  console.log(`Evidence: ${path.resolve(repoRoot, options.out)}`);
  return result.exitCode;
}

const isEntrypoint = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = error instanceof UsageError ? 64 : 2;
    });
}
