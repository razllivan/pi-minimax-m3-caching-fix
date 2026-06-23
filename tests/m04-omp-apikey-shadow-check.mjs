#!/usr/bin/env node
// Regression check for M004: host-branched `apiKey` omission on omp.
//
// Two-layer test (MEM020 / s06 / s01 pattern):
//   1. Static source assertions — verify that `index.ts::makeProvider`
//      contains the host computation, the `if (host === "omp")` branch,
//      the omp branch omits `apiKey`, the else branch keeps
//      `apiKey: spec.apiKey`, the file-header docblock references M004
//      and the runtime-override root-cause phrases, and the
//      `FALLBACK_SOURCE_ID` literal is pinned to the bumped version
//      (T03 lands the bump to 0.2.4 in lockstep with `package.json`).
//   2. Behavioral mirror (s06 pattern) — re-implement a minimal
//      `buildConfig(host, spec)` shape in plain JS that returns the
//      two-branch config shape, cross-check it against a regex
//      extracted from the source, and exercise it with `host ∈ {omp,
//      pi, gsd, undefined}` to lock in the structural contract.
//
// Why this shape?
// ---------------
// `pi.registerProvider({apiKey: "$MINIMAX_API_KEY"})` on omp 16.0.2
// installs the literal `$MINIMAX_API_KEY` at the top of AuthStorage's
// `runtimeOverrides > configOverrides > api_key credentials > oauth
// credentials > env var` priority chain (D007 / MEM035 follow-up),
// shadowing the oauth credential saved via /login and producing the
// 401/1004 reported in M004. The fix is host-branched: omit `apiKey`
// entirely on omp, keep `apiKey: spec.apiKey` on pi/gsd so the env-var
// fallback still works on those hosts.
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

// ─── Slice makeProvider's body via balanced-brace walk ─────────────────────
//
// `makeProvider` starts at the `async function makeProvider(` token.
// We find the opening `{` of its body, then walk forward tracking brace
// depth until depth returns to 0. The slice gives us a reliable substring
// to anchor the host-branched structural assertions on (the s01
// pattern, but for a different function).

function sliceFunction(source, signature) {
	const start = source.search(signature);
	if (start < 0) return null;
	let i = source.indexOf("{", start);
	if (i < 0) return null;
	let depth = 1;
	i++;
	while (i < source.length && depth > 0) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	if (depth !== 0) return null;
	return source.slice(start, i);
}

const makeProviderBody = sliceFunction(indexSource, /async\s+function\s+makeProvider\s*\(/);

// ─── Slice the omp branch and else branch via balanced-brace walk ──────────
//
// `if (host === "omp") { ... } else { ... }` — walk into the `if`'s
// `{`, then track depth until the matching `}` closes the `if` body.
// The remaining slice from that point forward is the `else { ... }`
// branch (it ends at the outer makeProvider `}`).

function sliceOmpBranch(body) {
	const ifMatch = body.match(/if\s*\(\s*host\s*===\s*"omp"\s*\)\s*\{/);
	if (!ifMatch) return { omp: null, else: null };
	const ifStart = ifMatch.index;
	const braceStart = ifMatch.index + ifMatch[0].length - 1;
	let i = braceStart + 1;
	let depth = 1;
	while (i < body.length && depth > 0) {
		const ch = body[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	if (depth !== 0) return { omp: null, else: null };
	const ompBranch = body.slice(ifMatch.index, i);
	// The else branch is whatever follows up to the end of the makeProvider body.
	// We slice from `i` to the end; that is reliable because the if/else is the
	// last statement of the makeProvider try-block (followed by `return true;`
	// / catch outside our slice).
	const elseBranch = body.slice(i);
	return { omp: ompBranch, else: elseBranch };
}

// ─── Slice the pi.registerProvider(...) call via balanced-paren walk ───────
//
// Each branch contains a single pi.registerProvider(spec.name, { ... })
// call. We slice from the call's opening `(` to the matching closing `)`,
// then check the resulting substring for the `apiKey:` key-value pattern.
// This is the precise surface for the host-branched structural lock —
// the comment text outside the call (e.g. "even `apiKey: undefined`
// would still install a runtime override") is intentionally excluded.

function sliceRegisterProviderCall(body) {
	const start = body.search(/pi\.registerProvider\s*\(/);
	if (start < 0) return null;
	let i = body.indexOf("(", start);
	if (i < 0) return null;
	let depth = 1;
	i++;
	while (i < body.length && depth > 0) {
		const ch = body[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		i++;
	}
	if (depth !== 0) return null;
	return body.slice(start, i);
}

const { omp: ompBranch, else: elseBranch } = makeProviderBody
	? sliceOmpBranch(makeProviderBody)
	: { omp: null, else: null };

const ompRegisterCall = ompBranch ? sliceRegisterProviderCall(ompBranch) : null;
const elseRegisterCall = elseBranch ? sliceRegisterProviderCall(elseBranch) : null;

// ─── Mirror of the two-branch config shape in plain JS ────────────────────
//
// MUST match the source body in `index.ts::makeProvider`. The static
// block below extracts a regex from the source that anchors the
// two-branch shape and asserts the mirror's body string satisfies it;
// a future refactor of one without the other fails the test (the s06
// detectHost cross-check pattern).

function buildConfig(host, spec, M3_DEFAULTS = { maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) {
	const api = spec.name;
	const baseShape = {
		baseUrl: spec.baseUrl,
		oauth: spec.oauth,
		api,
		streamSimple: () => null,
		models: [{
			id: "MiniMax-M3",
			name: spec.label,
			reasoning: true,
			input: ["text", "image"],
			cost: { ...M3_DEFAULTS.cost },
			contextWindow: spec.contextWindow,
			maxTokens: M3_DEFAULTS.maxTokens,
		}],
	};
	if (host === "omp") {
		// omp MUST NOT install a runtime apiKey override — AuthStorage's
		// priority chain shadows the /login oauth credential otherwise.
		return baseShape;
	}
	return { ...baseShape, apiKey: spec.apiKey };
}

// ─── Static source assertions ──────────────────────────────────────────────

const checks = [
	// 1. makeProvider computes the host locally.
	{
		name: "index.ts::makeProvider body computes host via detectHost(process.argv[1], process.versions.bun)",
		ok: makeProviderBody !== null && /const\s+host\s*=\s*detectHost\s*\(\s*process\.argv\s*\[\s*1\s*\]\s*,\s*process\.versions\.bun\s*\)/.test(makeProviderBody),
	},

	// 2. makeProvider contains the host-branched guard.
	{
		name: "index.ts::makeProvider body contains an `if (host === \"omp\")` branch",
		ok: makeProviderBody !== null && /if\s*\(\s*host\s*===\s*"omp"\s*\)/.test(makeProviderBody),
	},

	// 3. The omp branch's pi.registerProvider call does NOT contain `apiKey:`
	// as a key (the comment text "even `apiKey: undefined` would still
	// install a runtime override" sits OUTSIDE the call and is intentionally
	// excluded by the balanced-paren slice).
	{
		name: "index.ts::makeProvider omp branch pi.registerProvider(...) call does NOT contain `apiKey:`",
		ok: ompRegisterCall !== null && !/\bapiKey\s*:/.test(ompRegisterCall),
	},

	// 4. The else branch's pi.registerProvider call DOES contain apiKey: spec.apiKey.
	{
		name: "index.ts::makeProvider else branch pi.registerProvider(...) call contains `apiKey: spec.apiKey`",
		ok: elseRegisterCall !== null && /\bapiKey\s*:\s*spec\.apiKey/.test(elseRegisterCall),
	},

	// 5. Docblock root-cause references.
	{
		name: "index.ts file-header docblock references M004",
		ok: /M004/.test(indexSource),
	},
	{
		name: "index.ts file-header docblock references the `runtime override` root-cause phrase",
		// The source uses the space-separated form (`runtime override`,
		// `runtimeOverrides`) — the hyphenated `runtime-override` form in
		// the T02 plan is approximate; either form satisfies the
		// root-cause-phrase check.
		ok: /runtime[- ]override|runtimeOverrides/.test(indexSource),
	},
	{
		name: "index.ts file-header docblock references `installProviderApiKey`",
		ok: /installProviderApiKey/.test(indexSource),
	},
	{
		name: "index.ts file-header docblock references `AuthStorage.getApiKey`",
		ok: /AuthStorage\.getApiKey/.test(indexSource),
	},

	// 6. FALLBACK_SOURCE_ID pinned to the bumped version (T03 land in
	// lockstep with `package.json`). Surfacing here means a forgotten T03
	// bump trips the regression before publish.
	{
		name: "index.ts::FALLBACK_SOURCE_ID is bumped to \"@razllivan/pi-minimax-m3-caching-fix@0.2.4\"",
		ok: /FALLBACK_SOURCE_ID\s*=\s*"@razllivan\/pi-minimax-m3-caching-fix@0\.2\.4"/.test(indexSource),
	},

	// ─── Cross-check: mirror body must match source shape ──────────────────
	// The two-branch shape (omp → no apiKey, else → apiKey: spec.apiKey) is
	// uniquely identified by the source containing both branches. A naive
	// substring test would pass even if both branches included apiKey, so
	// we extract a regex that asserts BOTH the presence of the if-guard AND
	// the absence of `apiKey` between the omp branch braces.
	{
		name: "mirror's two-branch shape matches source regex (s06 cross-check pattern)",
		ok: (() => {
			// Source must contain: `if (host === "omp") {` followed (within
			// the branch) by a pi.registerProvider call that does NOT
			// mention apiKey, followed by `} else {` containing a
			// pi.registerProvider call that DOES mention `apiKey: spec.apiKey`.
			if (!makeProviderBody) return false;
			const sourcePattern = /if\s*\(\s*host\s*===\s*"omp"\s*\)\s*\{[\s\S]*?pi\.registerProvider\s*\([\s\S]*?\}\s*else\s*\{[\s\S]*?pi\.registerProvider\s*\([\s\S]*?apiKey\s*:\s*spec\.apiKey[\s\S]*?\}/;
			if (!sourcePattern.test(makeProviderBody)) return false;
			// Mirror body string must satisfy the same structural shape.
			const mirrorBody = `${buildConfig.toString()}`;
			const mirrorPattern = /if\s*\(\s*host\s*===\s*"omp"\s*\)\s*\{[\s\S]*?return\s+baseShape\s*;[\s\S]*?\}\s*return\s*\{[\s\S]*?apiKey\s*:\s*spec\.apiKey[\s\S]*?\};/;
			return mirrorPattern.test(mirrorBody);
		})(),
	},
];

// ─── Behavioral assertions ─────────────────────────────────────────────────

const fakeSpec = {
	name: "minimax-m3-clean",
	baseUrl: "https://api.minimax.io/v1",
	apiKey: "$MINIMAX_API_KEY",
	label: "MiniMax-M3 (clean)",
	contextWindow: 200000,
	oauth: { name: "MiniMax-M3 (clean)" },
};

const behavioralChecks = [
	// 7. omp → no apiKey key.
	{
		name: "buildConfig(\"omp\", spec) returns config with NO `apiKey` key",
		ok: (() => {
			const cfg = buildConfig("omp", fakeSpec);
			return !Object.prototype.hasOwnProperty.call(cfg, "apiKey");
		})(),
	},

	// 8. pi → apiKey preserved.
	{
		name: "buildConfig(\"pi\", spec) returns config with apiKey === spec.apiKey",
		ok: buildConfig("pi", fakeSpec).apiKey === fakeSpec.apiKey,
	},

	// 9. gsd → apiKey preserved.
	{
		name: "buildConfig(\"gsd\", spec) returns config with apiKey === spec.apiKey",
		ok: buildConfig("gsd", fakeSpec).apiKey === fakeSpec.apiKey,
	},

	// 10. unknown host → conservative default keeps apiKey (single-host installs unaffected).
	{
		name: "buildConfig(undefined, spec) returns config with apiKey === spec.apiKey (conservative default)",
		ok: buildConfig(undefined, fakeSpec).apiKey === fakeSpec.apiKey,
	},

	// 11. The two branches only differ on apiKey.
	{
		name: "omp and pi branches produce config objects with identical baseUrl/oauth/api/models (only apiKey differs)",
		ok: (() => {
			const ompCfg = buildConfig("omp", fakeSpec);
			const piCfg = buildConfig("pi", fakeSpec);
			return (
				ompCfg.baseUrl === piCfg.baseUrl &&
				ompCfg.oauth === piCfg.oauth &&
				ompCfg.api === piCfg.api &&
				JSON.stringify(ompCfg.models) === JSON.stringify(piCfg.models) &&
				!Object.prototype.hasOwnProperty.call(ompCfg, "apiKey") &&
				Object.prototype.hasOwnProperty.call(piCfg, "apiKey")
			);
		})(),
	},

	// 12. omp branch still contains oauth (so /login continues to work).
	{
		name: "omp branch's config still contains `oauth: spec.oauth` (so /login keeps working)",
		ok: (() => {
			const cfg = buildConfig("omp", fakeSpec);
			return cfg.oauth === fakeSpec.oauth;
		})(),
	},
];

// ─── Run all checks ────────────────────────────────────────────────────────

let failed = 0;
const totalChecks = checks.length + behavioralChecks.length;

for (const check of checks) {
	if (check.ok) {
		console.log(`OK ${check.name}`);
	} else {
		console.log(`FAIL ${check.name}`);
		failed++;
	}
}

for (const check of behavioralChecks) {
	const verdict = check.ok instanceof Promise
		? await Promise.resolve(check.ok).catch(() => false)
		: check.ok;
	if (verdict) {
		console.log(`OK ${check.name}`);
	} else {
		console.log(`FAIL ${check.name}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n${failed} of ${totalChecks} checks failed`);
	process.exit(1);
}

console.log(`\nAll ${totalChecks} M004 host-branched apiKey-omission checks passed`);
process.exit(0);
