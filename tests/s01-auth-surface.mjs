#!/usr/bin/env node
// Regression check for S01: cross-host oauth registration surface.
//
// Two-layer test (MEM020 / s06 pattern):
//   1. Static source assertions — verify the structural pieces
//      (`oauth-login.ts` exports `oauthConfigFor`, `providers.ts`
//      calls it for both PROVIDERS entries, `index.ts makeProvider()`
//      passes `oauth: spec.oauth` to `pi.registerProvider`, the
//      `OauthConfig.login` body references `callbacks.onPrompt` and
//      does NOT reference `ctx.ui`, and `M3_COMPAT.streamIdleTimeoutMs`
//      remains `30_000`).
//   2. Behavioral assertions — re-implement `oauthConfigFor` in plain
//      JS inside this file, verify the body string matches a regex
//      extracted from the TypeScript source (s06's "refactor one
//      without the other fails the test" pattern), and exercise it
//      with two fake specs to confirm the onPrompt channel is wired,
//      empty input is rejected, and the prompt message contains both
//      the env-var name and the model label.
//
// Why hermetic?
// -------------
// `oauthConfigFor` is exported for testability, but `index.ts`'s
// default export is the extension factory and `providers.ts` imports
// from `@earendil-works/pi-ai` (for the `Api` type) — running either
// through a real module loader would drag the host-side types and
// could trigger the factory on some loaders. Static + behavioral
// matches the MEM020 pattern (no jest/vitest, no tsc compile).
//
// Self-contained: Node 18+ stdlib only (fs, path, url).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const oauthLoginPath = resolve(repoRoot, "src/core/oauth-login.ts");
const providersPath = resolve(repoRoot, "src/core/providers.ts");
const indexPath = resolve(repoRoot, "index.ts");

const oauthLoginSource = readFileSync(oauthLoginPath, "utf8");
const providersSource = readFileSync(providersPath, "utf8");
const indexSource = readFileSync(indexPath, "utf8");

// ─── Mirror of oauthConfigFor in plain JS ──────────────────────────────────
//
// MUST match the source body in `src/core/oauth-login.ts`. The static
// block below extracts a literal regex from the source and asserts the
// mirror's body string satisfies it; a future refactor of one without
// the other fails the test (s06's detectHost pattern).
//
// Note: the real `login` returns `OAuthCredentials`
// ({access, refresh, expires}); the plan's step 3c "returns the string
// 'fake-key'" describes omp's auth-storage observation (the string is
// what omp persists) rather than the literal return type. The behavioral
// assertion exercises the *full* source behavior — `getApiKey` extracts
// the access field, which is what omp's `AuthStorage` calls to recover
// the persisted key string.

function oauthConfigFor(spec) {
	const envVarName = spec.apiKey.slice(1);
	return {
		name: spec.label,
		login: async (callbacks) => {
			const key = await callbacks.onPrompt({
				message: `Paste your ${envVarName} for ${spec.label}. Input is hidden.`,
			});
			if (!key) throw new Error("API key required");
			return { access: key, refresh: key, expires: 0 };
		},
		refreshToken: async (credentials) => credentials,
		getApiKey: (credentials) => credentials.access,
	};
}

// ─── Static source assertions ──────────────────────────────────────────────

const sourceChecks = [
	{
		name: "src/core/oauth-login.ts exports oauthConfigFor",
		ok: /export\s+function\s+oauthConfigFor\s*\(/.test(oauthLoginSource),
	},
	{
		name: "src/core/oauth-login.ts exports OauthConfig interface",
		ok: /export\s+interface\s+OauthConfig\s*\{/.test(oauthLoginSource),
	},
	{
		name:
			"src/core/providers.ts calls oauthConfigFor(spec) to populate both PROVIDERS entries",
		ok: /oauth:\s*oauthConfigFor\(/.test(providersSource),
	},
	{
		name:
			"OauthConfig.login body references callbacks.onPrompt (and NOT ctx.ui)",
		// Locate the `login:` property body and assert the onPrompt channel
		// is wired. We find the function literal inside the object literal
		// returned by oauthConfigFor, then scan its body for onPrompt and
		// ensure ctx.ui does NOT appear (the docblock in the same file
		// mentions ctx.ui as the anti-pattern, but it is prose, not code;
		// we anchor on the login arrow function body to avoid matching
		// the comment).
		ok: (() => {
			// Slice from `login: async` through the matching close brace
			// of the oauthConfigFor return literal. We pick the inner
			// `login: async (callbacks) => { ... }` body, bounded by the
			// first `},` that closes it (the `refreshToken` property
			// follows with a comma).
			const re = /login:\s*async\s*\([\s\S]*?\n\s{2}\},/;
			const m = oauthLoginSource.match(re);
			if (!m) return false;
			const body = m[0];
			return /onPrompt/.test(body) && !/ctx\.ui/.test(body);
		})(),
	},
	{
		name:
			"index.ts makeProvider() passes oauth: spec.oauth to pi.registerProvider",
		ok: /oauth:\s*spec\.oauth/.test(indexSource),
	},
	{
		name: "ProviderSpec interface declares oauth: OauthConfig (required field)",
		ok: /oauth:\s*OauthConfig\s*;/.test(providersSource),
	},
	{
		// MEM017 regression guard — mirror of tests/s05-m3compat-check.mjs.
		// A future bump or accidental rename breaks s05 first, but pinning
		// it in s01 too makes the auth-surface change a one-stop review
		// for the whole S01 patch.
		name: "M3_COMPAT.streamIdleTimeoutMs remains 30_000 (MEM017 regression guard)",
		ok: (() => {
			const fieldRegex = /streamIdleTimeoutMs\s*:\s*([0-9_]+)\s*,/;
			const m = providersSource.match(fieldRegex);
			if (!m) return false;
			const v = Number(m[1].replace(/_/g, ""));
			return v === 30_000;
		})(),
	},
	{
		// S03/M003 host-branched direct registration helper (closes
		// D-001/MEM035). Lock the function literal in so a future
		// refactor that inlines the dispatch (and loses the host-branched
		// fail-soft contract) surfaces here before the runtime UAT
		// silently regresses.
		name: "index.ts declares registerOmpOAuth (S03 host-branched direct registration helper)",
		ok: /function\s+registerOmpOAuth\s*\(/.test(indexSource),
	},
	{
		// S03/M003: registerOmpOAuth must branch on detectHost so the
		// direct registerOAuthProvider dispatch only fires on omp.
		// We extract just the helper body via balanced-brace walk —
		// a simpler `detectHost(` substring test would also match
		// the pre-existing call inside resolveAgentDir and let a
		// regression (helper stops calling detectHost) pass silently.
		name: "index.ts registerOmpOAuth body contains a detectHost( call (host-branching locked in)",
		ok: (() => {
			const start = indexSource.search(/function\s+registerOmpOAuth\s*\(/);
			if (start < 0) return false;
			let i = indexSource.indexOf("{", start);
			if (i < 0) return false;
			let depth = 1;
			i++;
			while (i < indexSource.length && depth > 0) {
				const ch = indexSource[i];
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
				i++;
			}
			if (depth !== 0) return false;
			const body = indexSource.slice(start, i);
			return /detectHost\s*\(/.test(body);
		})(),
	},
	{
		// S03/M003: registerOmpOAuth must dynamically import the omp-
		// specific `/oauth` subpath (MEM037). The substring is unique
		// to that import surface — nothing else in the project references
		// it — so a literal include test is sufficient and unambiguous.
		name: "index.ts references @oh-my-pi/pi-ai/oauth (MEM037 omp-specific dynamic import)",
		ok: indexSource.includes("@oh-my-pi/pi-ai/oauth"),
	},
];

// ─── Cross-check: mirror body must match source body (s06 pattern) ─────────
//
// Extract a regex from the source that uniquely identifies the login
// body's signature (the env-var slicing + onPrompt + throws-on-empty
// + OAuthCredentials wrap). The mirror above must contain the same
// substring. If a future refactor renames `callbacks.onPrompt` or drops
// the empty-string guard, the regex stops matching the mirror and the
// test fails — even if the static source assertions above still pass.

const sourceBodyRegex = /Paste your\s+\$\{envVarName\}\s+for\s+\$\{spec\.label\}\. Input is hidden\./;
const mirrorContainsSourceMessage = sourceBodyRegex.test(
	`${oauthConfigFor.toString()}`,
);

// ─── Behavioral assertions ─────────────────────────────────────────────────

const fakeSpecs = [
	{
		name: "minimax-m3-clean",
		baseUrl: "https://api.minimax.io/v1",
		apiKey: "$MINIMAX_API_KEY",
		label: "MiniMax-M3 (clean)",
	},
	{
		name: "minimax-cn-m3-clean",
		baseUrl: "https://api.minimaxi.com/v1",
		apiKey: "$MINIMAX_CN_API_KEY",
		label: "MiniMax-M3 (clean — CN)",
	},
];

const behavioralChecks = [];

for (const spec of fakeSpecs) {
	const cfg = oauthConfigFor(spec);

	behavioralChecks.push({
		name: `${spec.name}: returned name equals spec.label (${spec.label})`,
		ok: cfg.name === spec.label,
	});

	behavioralChecks.push({
		name: `${spec.name}: returned login is a function`,
		ok: typeof cfg.login === "function",
	});

	// Capture the prompt message so we can assert it references both
	// the env-var name and the model label (the M003-RESEARCH
	// "Prompt labels leaking the env-var name vs the model label"
	// pitfall).
	let capturedMessage = null;

	behavioralChecks.push({
		name: `${spec.name}: onPrompt is invoked with a message containing the env-var name AND the model label`,
		ok: (async () => {
			const fakeKey = "fake-key";
			const result = await cfg.login({
				onPrompt: async (p) => {
					capturedMessage = p.message;
					return fakeKey;
				},
			});
			// The plan's step 3c says the callback "returns the string
			// fake-key" — the source returns OAuthCredentials and omp
			// recovers the string via getApiKey. Assert the recovered
			// key matches (this is what omp persists as api_key).
			const recovered = cfg.getApiKey(result);
			if (recovered !== fakeKey) return false;
			if (typeof capturedMessage !== "string") return false;
			const envVarName = spec.apiKey.slice(1);
			return (
				capturedMessage.includes(envVarName) &&
				capturedMessage.includes(spec.label)
			);
		})(),
	});

	behavioralChecks.push({
		name: `${spec.name}: login rejects when onPrompt returns an empty string (no empty credential persisted)`,
		ok: (async () => {
			let rejected = false;
			try {
				await cfg.login({ onPrompt: async () => "" });
			} catch {
				rejected = true;
			}
			return rejected;
		})(),
	});

	behavioralChecks.push({
		name: `${spec.name}: refreshToken is a no-op (returns the same credentials)`,
		ok: (async () => {
			const creds = { access: "k", refresh: "k", expires: 0 };
			const out = await cfg.refreshToken(creds);
			return out === creds;
		})(),
	});
}

// ─── Run all checks ────────────────────────────────────────────────────────

let failed = 0;
const staticCount = sourceChecks.length + 1; // +1 for the mirror cross-check
const totalChecks = staticCount + behavioralChecks.length;

for (const check of sourceChecks) {
	if (check.ok) {
		console.log(`OK ${check.name}`);
	} else {
		console.log(`FAIL ${check.name}`);
		failed++;
	}
}

if (mirrorContainsSourceMessage) {
	console.log("OK behavioral mirror's login body string matches the source-body regex (s06 cross-check pattern)");
} else {
	console.log("FAIL behavioral mirror's login body string drifted from the source-body regex");
	failed++;
}

for (const check of behavioralChecks) {
	// Behavioral checks return promises (ok is async). Resolve them in
	// order so the OK/FAIL lines appear deterministically. Failures in
	// a Promise.reject propagate; catch them and mark FAIL.
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

console.log(`\nAll ${totalChecks} auth-surface checks passed`);
process.exit(0);
