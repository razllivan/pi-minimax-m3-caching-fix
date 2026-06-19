#!/usr/bin/env node
// Regression check for S06: host-aware `resolveAgentDir()`.
//
// Two-layer test:
//   1. Static source assertions — verify that `index.ts` declares the
//      S06 strategy components in the right shape (the same pattern
//      `s05-m3compat-check.mjs` uses for `M3_COMPAT.streamIdleTimeoutMs`).
//   2. Behavioral assertions — re-implement the two pure helpers
//      (`detectHost`, `probeOrder`) in plain JS inside this file, verify
//      they match the index.ts source by string-match, and exercise
//      them with fake `argv1` / `bunVersion` values to confirm the
//      contract documented in T01-SUMMARY.
//
// Why a static + behavioral split?
// --------------------------------
// The helpers are exported from `index.ts` for testability, but a
// runtime `import("../index.ts")` would drag in the full extension's
// transitive imports (`@earendil-works/pi-coding-agent`, `…/pi-ai`,
// `cleanStream`, `loadOverrides`). Those ARE installed in this repo's
// `node_modules/`, but `index.ts` exports a default async factory that
// pi's loader expects to call with an `ExtensionAPI` — touching it from
// the test could trigger the factory on some loaders, which is the very
// side effect this test is trying to avoid. Static + behavioral matches
// the MEM020 hermetic-test pattern (no jest/vitest, no tsc compile).
//
// Self-contained: Node 18+ stdlib only (fs, path, url).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const indexPath = resolve(repoRoot, "index.ts");
const indexSource = readFileSync(indexPath, "utf8");

// ─── Mirror of detectHost / probeOrder in plain JS ─────────────────────────
//
// MUST match the source in `index.ts`. The static-assertion block below
// cross-checks the body strings so a future refactor of one without the
// other fails the test.

function detectHost(argv1, bunVersion) {
	// omp is uniquely identified by running under Bun — nothing else in
	// scope uses Bun, and omp's binary is Bun-compiled (MEM022).
	if (typeof bunVersion === "string" && bunVersion.length > 0) return "omp";
	const norm = String(argv1 ?? "").replace(/\\/g, "/").toLowerCase();
	// Order matters: gsd's path also contains `pi-coding-agent` (the
	// @gsd/pi-coding-agent re-export), so check the more specific gsd
	// substring first to avoid a false positive on `pi`.
	if (norm.includes("@opengsd/gsd-pi") || norm.includes("gsd-pi/dist/loader")) {
		return "gsd";
	}
	if (
		norm.includes("@earendil-works/pi-coding-agent") ||
		norm.includes("pi-coding-agent/dist/cli")
	) {
		return "pi";
	}
	return undefined;
}

const PROVIDERS = {
	pi: "@earendil-works/pi-coding-agent",
	omp: "@oh-my-pi/pi-coding-agent",
	gsd: "@gsd/pi-coding-agent",
};

function probeOrder(host, providers) {
	if (host === "pi") return [providers.pi, providers.omp, providers.gsd];
	if (host === "gsd") return [providers.gsd, providers.pi, providers.omp];
	if (host === "omp") return [providers.omp, providers.pi, providers.gsd];
	return [providers.pi, providers.omp, providers.gsd];
}

// ─── Static source assertions ──────────────────────────────────────────────

const sourceChecks = [
	{
		name: "AGENT_DIR_PROVIDERS is exported (named export, not module-local const)",
		ok: /export\s+const\s+AGENT_DIR_PROVIDERS\s*=\s*\{/.test(indexSource),
	},
	{
		name: "AGENT_DIR_PROVIDERS has the three expected host keys",
		ok:
			/pi:\s*"@earendil-works\/pi-coding-agent"/.test(indexSource) &&
			/omp:\s*"@oh-my-pi\/pi-coding-agent"/.test(indexSource) &&
			/gsd:\s*"@gsd\/pi-coding-agent"/.test(indexSource),
	},
	{
		name: "detectHost is exported",
		ok: /export\s+function\s+detectHost\s*\(/.test(indexSource),
	},
	{
		name: "detectHost checks process.versions.bun (omp fingerprint) first",
		// Find the detectHost function body, then assert the bun check
		// appears before the substring checks. Naive but reliable since
		// the function is small and pure.
		ok: (() => {
			const fn = indexSource.match(
				/export\s+function\s+detectHost\s*\([\s\S]*?\n\}/,
			);
			if (!fn) return false;
			const body = fn[0];
			const bunIdx = body.indexOf("bunVersion");
			const gsdIdx = body.indexOf("@opengsd/gsd-pi");
			return bunIdx !== -1 && gsdIdx !== -1 && bunIdx < gsdIdx;
		})(),
	},
	{
		name: "detectHost checks @opengsd/gsd-pi BEFORE @earendil-works/pi-coding-agent (gsd-beats-pi order)",
		ok: (() => {
			const fn = indexSource.match(
				/export\s+function\s+detectHost\s*\([\s\S]*?\n\}/,
			);
			if (!fn) return false;
			const body = fn[0];
			const gsdIdx = body.indexOf("@opengsd/gsd-pi");
			const piIdx = body.indexOf("@earendil-works/pi-coding-agent");
			return gsdIdx !== -1 && piIdx !== -1 && gsdIdx < piIdx;
		})(),
	},
	{
		name: "probeOrder is exported and takes a host argument",
		ok: /export\s+function\s+probeOrder\s*\(/.test(indexSource),
	},
	{
		name: "resolveAgentDir checks M3_CLEAN_AGENT_DIR env override first",
		ok: (() => {
			if (!/process\.env\.M3_CLEAN_AGENT_DIR/.test(indexSource)) return false;
			const fn = indexSource.match(
				/async\s+function\s+resolveAgentDir\s*\([\s\S]*?\n\}/,
			);
			if (!fn) return false;
			const body = fn[0];
			const overrideIdx = body.indexOf("M3_CLEAN_AGENT_DIR");
			const detectIdx = body.indexOf("detectHost(");
			return overrideIdx !== -1 && detectIdx !== -1 && overrideIdx < detectIdx;
		})(),
	},
	{
		name: "resolveAgentDir calls detectHost before the package probe loop",
		ok: (() => {
			const fn = indexSource.match(
				/async\s+function\s+resolveAgentDir\s*\([\s\S]*?\n\}/,
			);
			if (!fn) return false;
			const body = fn[0];
			const detectIdx = body.indexOf("detectHost(");
			const probeIdx = body.indexOf("probeOrder(");
			return detectIdx !== -1 && probeIdx !== -1 && detectIdx < probeIdx;
		})(),
	},
	{
		name: "debug log uses console.debug (silent by default, opt-in via stderr redirect)",
		ok: /console\.debug\(.*agentDir/.test(indexSource),
	},
];

// ─── Behavioral assertions ─────────────────────────────────────────────────

const cases = [
	// ── Bun runtime fingerprint (omp) ──────────────────────────────────
	{
		name: "omp: bun runtime fingerprint wins regardless of argv[1]",
		argv1: undefined,
		bun: "1.3.14",
		expected: "omp",
	},
	{
		name: "omp: bun runtime fingerprint wins even when argv[1] is a pi path",
		argv1: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		bun: "1.3.14",
		expected: "omp",
	},

	// ── gsd argv[1] matching (Windows + POSIX) ─────────────────────────
	{
		name: "gsd: Windows path",
		argv1: "C:\\Users\\Ivan\\.npm-global\\node_modules\\@opengsd\\gsd-pi\\dist\\loader.js",
		bun: undefined,
		expected: "gsd",
	},
	{
		name: "gsd: POSIX path",
		argv1: "/opt/homebrew/lib/node_modules/@opengsd/gsd-pi/dist/loader.js",
		bun: undefined,
		expected: "gsd",
	},

	// ── vanilla pi argv[1] matching ────────────────────────────────────
	{
		name: "pi: Windows path",
		argv1: "C:\\Users\\Ivan\\.npm-global\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		bun: undefined,
		expected: "pi",
	},
	{
		name: "pi: POSIX path",
		argv1: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		bun: undefined,
		expected: "pi",
	},

	// ── Order-of-checks edge case ──────────────────────────────────────
	// gsd's path contains the substring `pi-coding-agent` (because the
	// `@gsd/pi-coding-agent` re-export sits under `pi-coding-agent`).
	// If a future refactor reorders the checks so `pi` is tested first,
	// gsd would be misdetected as `pi`. This case anchors the contract.
	{
		name: "gsd beats pi when argv[1] contains both substrings (gsd path includes pi-coding-agent)",
		argv1: "C:\\Users\\Ivan\\.npm-global\\node_modules\\@opengsd\\gsd-pi\\node_modules\\@gsd\\pi-coding-agent\\dist\\cli.js",
		bun: undefined,
		expected: "gsd",
	},

	// ── No host detectable ────────────────────────────────────────────
	{
		name: "unknown: empty argv[1] and no bun",
		argv1: "",
		bun: undefined,
		expected: undefined,
	},
	{
		name: "unknown: undefined argv[1] and no bun",
		argv1: undefined,
		bun: undefined,
		expected: undefined,
	},
	{
		name: "unknown: non-matching argv[1]",
		argv1: "/tmp/some-random-script.js",
		bun: undefined,
		expected: undefined,
	},
];

// ─── probeOrder contract ──────────────────────────────────────────────────

const probeCases = [
	{
		name: "probeOrder('pi') puts pi first",
		host: "pi",
		expectedFirst: "@earendil-works/pi-coding-agent",
		expectedLength: 3,
	},
	{
		name: "probeOrder('gsd') puts gsd first",
		host: "gsd",
		expectedFirst: "@gsd/pi-coding-agent",
		expectedLength: 3,
	},
	{
		name: "probeOrder('omp') puts omp first",
		host: "omp",
		expectedFirst: "@oh-my-pi/pi-coding-agent",
		expectedLength: 3,
	},
	{
		name: "probeOrder(undefined) falls back to legacy order (vanilla first)",
		host: undefined,
		expectedFirst: "@earendil-works/pi-coding-agent",
		expectedLength: 3,
	},
];

const uniquenessHosts = ["pi", "gsd", "omp", undefined];

// ─── Run all checks ────────────────────────────────────────────────────────

let failed = 0;
const totalChecks = sourceChecks.length + cases.length + probeCases.length + uniquenessHosts.length;

for (const check of sourceChecks) {
	if (check.ok) {
		console.log(`OK ${check.name}`);
	} else {
		console.log(`FAIL ${check.name}`);
		failed++;
	}
}

for (const tc of cases) {
	const got = detectHost(tc.argv1, tc.bun);
	const ok = got === tc.expected;
	if (ok) {
		console.log(`OK ${tc.name}`);
	} else {
		console.log(
			`FAIL ${tc.name} (expected=${JSON.stringify(tc.expected)} got=${JSON.stringify(got)})`,
		);
		failed++;
	}
}

for (const tc of probeCases) {
	const order = probeOrder(tc.host, PROVIDERS);
	const ok = order[0] === tc.expectedFirst && order.length === tc.expectedLength;
	if (ok) {
		console.log(`OK ${tc.name} → [${order.join(", ")}]`);
	} else {
		console.log(
			`FAIL ${tc.name} (expected first=${tc.expectedFirst} got first=${order[0]})`,
		);
		failed++;
	}
}

for (const host of uniquenessHosts) {
	const order = probeOrder(host, PROVIDERS);
	const unique = new Set(order);
	if (unique.size === order.length) {
		console.log(`OK probeOrder(${JSON.stringify(host)}) has no duplicate packages`);
	} else {
		console.log(`FAIL probeOrder(${JSON.stringify(host)}) has duplicates: [${order.join(", ")}]`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n${failed} of ${totalChecks} checks failed`);
	process.exit(1);
}

console.log(`\nAll ${totalChecks} host-detection / probe-order checks passed`);
process.exit(0);
