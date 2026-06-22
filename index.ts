/**
 * minimax-m3-clean — MiniMax-M3 on the OpenAI-compatible endpoint with
 * clean streaming output.
 *
 * pi 0.79.1 routes the built-in `minimax / MiniMax-M3` to the Anthropic-
 * compatible endpoint, which silently ignores `cache_control` (full
 * input price every turn). The OpenAI-compatible endpoint
 * (`/v1/chat/completions`) does passive caching — but M3 emits thinking
 * twice there: in `reasoning_content`/`reasoning` fields (consumed as
 * proper thinking blocks) and again inline in `content` as
 * `<think>…</think>`. It also alternates between the two reasoning
 * fields across chunks, which the openai-completions driver treats as
 * new blocks and re-streams from the start.
 *
 * The upstream fix (earendil-works/pi-mono b85b91c9, `skipThinkingBlock`)
 * is unreleased as of 0.79.1. This extension routes to the OpenAI-
 * compatible endpoint and rewrites the event stream in flight. The
 * stream wrapper is in `./src/core/clean-stream.ts`; the override-file
 * parser in `./src/core/overrides.ts`; the provider metadata in
 * `./src/core/providers.ts`. This file is the orchestrator: discovers
 * the agent dir, loads overrides, and registers the two providers.
 *
 * Fail-soft behavior (S02)
 * ------------------------
 * The orchestrator must not crash the whole session when this extension
 * loads on a host that refuses to accept a provider name conflict in
 * `pi.registerProvider(spec.name, ...)` (validation error throws). Each
 * `pi.registerProvider` call is wrapped in try/catch; on throw we record
 * a TUI warning naming the provider and continue with the next spec
 * instead of letting the exception propagate.
 *
 * Warnings are deferred to `session_start` because `ctx.ui.notify` is
 * not available in the extension factory — the same precedent S01
 * established for `overrides.invalid` entries.
 *
 * Top-level `streamSimple` bridge
 * -------------------------------
 * `streamSimple<TApi>(model, ctx, opts)` exists as a top-level export on
 * all three Pi-family hosts (vanilla `@earendil-works/pi-ai@0.79.1`,
 * gsd-pi's `@gsd/pi-ai` symlink facade, omp's `@oh-my-pi/pi-ai@16.0.2`).
 * It dispatches to the built-in driver for `model.api`; the wrapper
 * passes `{...model, api: "openai-completions", compat: M3_COMPAT}` to
 * reach the openai-completions driver without going through
 * `getApiProvider` (which omp dropped in 16.0.2 — see MEM006).
 *
 * The explicit `compat: M3_COMPAT` in the spread is structural, not
 * cosmetic: `pi.registerProvider` accepts a `compat` config and the
 * model's `compat` is set at registration time, but `buildCompat` (in
 * the host pi-ai) writes `compat: undefined` when the registered value
 * is not recognized as a known compat. omp's openai-completions driver
 * dereferences `model.compat.streamIdleTimeoutMs` on the first packet
 * and crashes with "undefined is not an object" when the field is
 * missing (S04 T04 evidence record 150700a3, S05 T01 evidence record
 * 745198ad). Re-passing the canonical `M3_COMPAT` object here — instead
 * of relying on whatever the registration path produced — guarantees
 * the value the wrapper actually receives is the value the driver
 * reads. This is the runtime half of MEM017 (MEM024 / MEM025); the
 * source half (declaring `streamIdleTimeoutMs` on M3_COMPAT) shipped
 * in S05.
 *
 * Cross-host oauth registration (S01/M003)
 * ---------------------------------------
 * `makeProvider()` also passes `oauth: spec.oauth` into
 * `pi.registerProvider`. This is the registration-shape change that
 * surfaces our providers in omp's `/login` selector: omp's
 * `AuthStorage.login()` invokes our `login()` callback (which closes
 * over `callbacks.onPrompt` — NOT the factory's `ctx.ui`, which is
 * `undefined` long after the extension factory has returned) and
 * persists the returned string as `api_key` via the
 * `typeof result === "string"` branch in omp's auth storage. On
 * pi/gsd the `oauth` block is accepted by `registerProvider`'s schema
 * but the host's own native `/login` API-key picker is what users
 * actually interact with — our entry is a no-op on those hosts.
 * Vanilla pi 0.79.1's `registerProvider` additionally validates
 * `config.oauth` against `Omit<OAuthProviderInterface, "id">`, which
 * requires `login`, `refreshToken`, and `getApiKey`; the S02 fail-soft
 * machinery catches the resulting validation throw and defers a
 * `session_start` warning naming the provider, so on vanilla pi the
 * provider is silently skipped rather than crashing the session. See
 * AGENTS.md §3 and `.gsd/milestones/M003/slices/S01/S01-RESEARCH.md`
 * for the documented cross-host asymmetry.
 *
 * Host-branched direct registration (S03/M003)
 * --------------------------------------------
 * `pi.registerProvider({oauth})` is the documented cross-host shape,
 * but D-001/MEM035 surfaced a real gap: on a multi-host dev machine
 * `validateProviderConfiguration` on omp 16.0.2 can throw before the
 * oauth-bearing dispatch is reached, and the S02 fail-soft catch in
 * `makeProvider` swallows the throw — so `registerOAuthProvider` is
 * never called and the provider is missing from `omp auth-broker
 * list --json`. The fix is a second, host-branched direct call to
 * `registerOAuthProvider` that bypasses the model-registry validation
 * path entirely. See `.gsd/milestones/M003/slices/S03/S03-RESEARCH.md`
 * for the root-cause analysis.
 *
 * The dispatch lives inside `registerOmpOAuth()` and is gated on
 * `detectHost(...)` returning `"omp"` — pi and gsd paths are
 * untouched, so the behavior on those hosts is identical to pre-S03.
 * The dynamic `import("@oh-my-pi/pi-ai/oauth")` is **only** invoked
 * on the omp branch because the `/oauth` subpath does not exist in
 * `@earendil-works/pi-ai` (vanilla pi); importing it unconditionally
 * would crash the extension on pi/gsd. If the import fails for any
 * reason (package missing, future shape change), the helper catches
 * the error, pushes a deferred `session_start` warning via the
 * shared `warnings` buffer, and returns without crashing the session —
 * preserving the S02 fail-soft contract. `registerOAuthProvider` itself
 * is also wrapped in try/catch for the same reason. The `sourceId`
 * field is read from `process.env.npm_package_name` /
 * `process.env.npm_package_version` when set (publish-time), with a
 * hard-coded `"@razllivan/pi-minimax-m3-caching-fix@0.2.2"` fallback
 * that matches the current `package.json` so `unregisterOAuthProviders`
 * can be invoked on reload without orphaning prior registrations.
 *
 * Why the dual-registration path is safe even when it succeeds twice:
 * `registerOAuthProvider` overwrites by `id`, so calling it from both
 * the `pi.registerProvider({oauth})` path AND the direct path simply
 * replaces the prior descriptor with an identical one. The order
 * (direct first, then `pi.registerProvider`) does not matter for the
 * descriptor state, but it does matter for the fail-soft contract: if
 * `pi.registerProvider` later throws, the descriptor from the direct
 * call is already in omp's `customOAuthProviders` map.
 *
 * See `.gsd/milestones/M003/slices/S03/S03-SUMMARY.md` for the slice
 * summary and verification record.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { streamSimple } from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cleanStream } from "./src/core/clean-stream";
import { loadOverrides } from "./src/core/overrides";
import { M3_COMPAT, M3_DEFAULTS, PROVIDERS, type ProviderSpec } from "./src/core/providers";

/** Three pi-family hosts this extension targets. Each one ships its own
 *  copy of `getAgentDir()` from its bundled `@…/pi-coding-agent` package.
 *  The strings are also dynamic `import()` specifiers — order matters.
 *  Exported so the regression test in `tests/s06-resolve-agent-dir.mjs`
 *  can read the package names without re-declaring them. */
export const AGENT_DIR_PROVIDERS = {
	pi: "@earendil-works/pi-coding-agent",
	omp: "@oh-my-pi/pi-coding-agent",
	gsd: "@gsd/pi-coding-agent",
} as const;

export type Host = keyof typeof AGENT_DIR_PROVIDERS;

/** Pure host detection. Self-contained (inlines the path-normalization
 *  step) so the regression test can `eval` the function body in isolation
 *  without dragging in module-level state. Cross-platform: Windows
 *  argv[1] is `C:\…\node_modules\@opengsd\gsd-pi\dist\loader.js`, POSIX
 *  is `/opt/homebrew/lib/node_modules/@opengsd/gsd-pi/dist/loader.js` —
 *  both match the substring `@opengsd/gsd-pi` after normalization. */
export function detectHost(
	argv1: string | undefined,
	bunVersion: string | undefined,
): Host | undefined {
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

/** Expand a leading `~` or `~/` to the user's home directory. Mirrors the
 *  POSIX-shell convention most users will reach for; we do not support
 *  `~user/` syntax because that requires `/etc/passwd` lookup and is not
 *  portable to Windows. */
function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
	return p;
}

/** Try one package specifier; return its `getAgentDir()` if it imports
 *  cleanly and exposes the function, else `undefined`. */
async function tryPackage(pkg: string): Promise<string | undefined> {
	try {
		const mod = await import(pkg);
		if (typeof mod.getAgentDir === "function") return mod.getAgentDir();
	} catch {
		// Package not installed in this runtime — try the next one.
	}
	return undefined;
}

/** Order in which to probe `getAgentDir()` packages for a given host.
 *  The matching host's package is tried first (it should be the source of
 *  truth on a single-host install); vanilla pi is always second because
 *  the legacy-pi-compat rewrite (MEM013) means `@earendil-works/pi-coding-agent`
 *  is the resolved module under omp on most setups; the remaining host is
 *  the last resort. Exported for the regression test; takes the providers
 *  map as an argument (defaulting to the module constant) so the test can
 *  inject a fixture without module-scope gymnastics. */
export function probeOrder(
	host: Host | undefined,
	providers: typeof AGENT_DIR_PROVIDERS = AGENT_DIR_PROVIDERS,
): readonly string[] {
	if (host === "pi") {
		return [providers.pi, providers.omp, providers.gsd];
	}
	if (host === "gsd") {
		return [providers.gsd, providers.pi, providers.omp];
	}
	if (host === "omp") {
		return [providers.omp, providers.pi, providers.gsd];
	}
	// No host detected — fall through to the legacy order (vanilla first,
	// then the others). Single-host installs still work.
	return [providers.pi, providers.omp, providers.gsd];
}

async function resolveAgentDir(): Promise<string | undefined> {
	// Priority 1: explicit user/test override. Validated for existence so
	// a stale value pointing at a deleted dir falls through to detection
	// rather than silently masking override-file loading.
	const override = process.env.M3_CLEAN_AGENT_DIR;
	if (override && override.length > 0) {
		const expanded = expandHome(override);
		try {
			const st = await stat(expanded);
			if (st.isDirectory()) {
				debugAgentDir("override", expanded);
				return expanded;
			}
		} catch {
			// Override dir missing or unreadable — log and fall through.
			console.debug(
				`[m3-clean] M3_CLEAN_AGENT_DIR=${override} is not a readable directory; falling through to host detection`,
			);
		}
	}

	// Priority 2: host detection (bun runtime fingerprint + argv[1] substring).
	const host = detectHost(process.argv[1], process.versions.bun);

	// Priority 3: per-host package probe, matching package first.
	for (const pkg of probeOrder(host)) {
		const dir = await tryPackage(pkg);
		if (dir) {
			debugAgentDir(host ?? "unknown", dir);
			return dir;
		}
	}
	debugAgentDir(host ?? "unknown", undefined);
	return undefined;
}

/** One-line diagnostic of the resolved agent dir. `console.debug` is the
 *  right tier: silent under default Node/Bun, visible if the user
 *  redirects stderr (`node ... 2>debug.log` or `DEBUG=*`). */
function debugAgentDir(host: string | "unknown", agentDir: string | undefined): void {
	console.debug(`[m3-clean] host=${host} agentDir=${agentDir ?? "<undefined>"}`);
}

/** Literal `sourceId` fallback for the dual-registration path. omp's
 *  `unregisterOAuthProviders(sourceId)` removes every provider whose
 *  `sourceId` matches, so the value must be stable across reloads. The
 *  publish-time env-var path (preferred when set) produces the same
 *  shape; this literal is the offline / non-pnpm fallback. Keep in
 *  sync with `package.json` `name` and `version` at bump time. */
const FALLBACK_SOURCE_ID = "@razllivan/pi-minimax-m3-caching-fix@0.2.2";

/** Resolve the stable `sourceId` string for `registerOAuthProvider`.
 *  Reads `process.env.npm_package_name` and `npm_package_version` when
 *  set (publish-time / `pnpm exec` invocations), falling back to the
 *  literal `FALLBACK_SOURCE_ID` constant otherwise. The runtime must
 *  not `require("../package.json")` because that path is not always
 *  resolvable on hosts that load the extension from a bundled cache
 *  (e.g. omp's `~/.bun/install/cache/...`). */
function resolveSourceId(): string {
	const name = process.env.npm_package_name;
	const version = process.env.npm_package_version;
	if (typeof name === "string" && name.length > 0 && typeof version === "string" && version.length > 0) {
		return `${name}@${version}`;
	}
	console.debug(`[m3-clean] registerOmpOAuth: npm_package_name/version not set; using fallback sourceId ${FALLBACK_SOURCE_ID}`);
	return FALLBACK_SOURCE_ID;
}

/** Host-branched direct `registerOAuthProvider` call (S03/M003).
 *
 *  Returns immediately when the active host is not omp (preserve pi/gsd
 *  behavior unchanged). On omp, dynamically imports
 *  `@oh-my-pi/pi-ai/oauth`, destructures `registerOAuthProvider`, and
 *  registers the spec's oauth descriptor under the provider id with a
 *  stable `sourceId`. The dynamic import is mandatory: the `/oauth`
 *  subpath exists on omp's `@oh-my-pi/pi-ai@16.0.2` (see
 *  `node_modules/@oh-my-pi/pi-ai/package.json` exports) but NOT on
 *  vanilla pi's `@earendil-works/pi-ai`, so importing it
 *  unconditionally would crash the extension on pi/gsd.
 *
 *  Fail-soft contract (S02): import errors and `registerOAuthProvider`
 *  throws both push a deferred warning into `warnings` and return
 *  without propagating — the host's session continues regardless of
 *  whether the omp auth-broker descriptor was registered.
 */
async function registerOmpOAuth(
	spec: ProviderSpec,
	warnings: string[],
): Promise<void> {
	// Honor the same host-detection chain as `resolveAgentDir` so a
	// multi-host dev machine routes correctly (MEM026 / S06).
	const host = detectHost(process.argv[1], process.versions.bun);
	if (host !== "omp") return;

	let registerOAuthProvider: ((provider: unknown) => void) | undefined;
	try {
		// Dynamic import — package is only present on omp. The `as
		// unknown` cast is local to this call site; the spec.oauth shape
		// is structurally compatible with omp's `OAuthProviderInterface`
		// at runtime (the host passes a superset of `OauthPromptCallbacks`
		// as `callbacks`, and our narrower parameter reads only the
		// fields it declared).
		const mod = (await import("@oh-my-pi/pi-ai/oauth" as string)) as {
			registerOAuthProvider?: (provider: unknown) => void;
		};
		registerOAuthProvider = mod.registerOAuthProvider;
		if (typeof registerOAuthProvider !== "function") {
			warnings.push(
				`m3-clean: @oh-my-pi/pi-ai/oauth exported but registerOAuthProvider is not a function on host "omp". Skipping host-branched registration for "${spec.name}".`,
			);
			return;
		}
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		warnings.push(
			`m3-clean: failed to dynamically import @oh-my-pi/pi-ai/oauth on host "omp" for "${spec.name}" — ${reason}. Skipping host-branched registration.`,
		);
		return;
	}

	try {
		// Build the omp descriptor structurally. The runtime shape is
		// `{id, name, sourceId?, login(callbacks) → Promise<OAuthCredentials | string>,
		// refreshToken?, getApiKey?}`. Our `spec.oauth` already satisfies
		// that (S01 T03 widened `OauthConfig` to include `refreshToken`
		// and `getApiKey`); the `as unknown as` cast bridges the
		// narrow-vs-OAuthLoginCallbacks parameter shape difference (the
		// host injects a superset and our login only reads the onPrompt
		// channel, so runtime is safe).
		const descriptor = {
			...spec.oauth,
			id: spec.name,
			sourceId: resolveSourceId(),
		} as unknown as Parameters<NonNullable<typeof registerOAuthProvider>>[0];
		registerOAuthProvider(descriptor);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		warnings.push(
			`m3-clean: registerOAuthProvider threw on host "omp" for "${spec.name}" — ${reason}. The host-branched descriptor was NOT registered.`,
		);
		return;
	}
}

async function makeProvider(
	pi: ExtensionAPI,
	spec: ProviderSpec,
	contextWindow: number,
	streamSimpleFn: typeof streamSimple,
	warnings: string[],
): Promise<boolean> {
	const api = spec.name as Api; // custom api id so only these models hit our handler
	// Host-branched direct registration FIRST so the oauth descriptor
	// is in omp's `customOAuthProviders` map even if the subsequent
	// `pi.registerProvider` call throws on a model-registry validation
	// edge (the D-001/MEM035 root cause per S03-RESEARCH §3).
	await registerOmpOAuth(spec, warnings);
	try {
		pi.registerProvider(spec.name, {
			baseUrl: spec.baseUrl,
			apiKey: spec.apiKey,
			oauth: spec.oauth,
			api,
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				const base = streamSimpleFn({ ...model, api: "openai-completions", compat: M3_COMPAT }, context, options);
				return cleanStream(base);
			},
			models: [{
				id: "MiniMax-M3",
				name: spec.label,
				reasoning: true,
				input: ["text", "image"],
				cost: { ...M3_DEFAULTS.cost },
				contextWindow,
				maxTokens: M3_DEFAULTS.maxTokens,
				compat: M3_COMPAT,
			}],
		});
		return true;
	} catch (err) {
		// registerProvider throws on validation error (e.g. duplicate name
		// when the host's built-in provider collides with our spec). Surface
		// via the deferred session_start notification and skip this provider.
		const reason = err instanceof Error ? err.message : String(err);
		warnings.push(
			`m3-clean: failed to register provider "${spec.name}" — ${reason}. Skipping.`,
		);
		return false;
	}
}

export default async function (pi: ExtensionAPI) {
	const agentDir = await resolveAgentDir();
	const overrides = agentDir
		? await loadOverrides(agentDir)
		: { contextWindow: M3_DEFAULTS.contextWindow, invalid: [] };

	// Always run the registration loop. `streamSimple` is a top-level
	// export on all three supported hosts; the openai-completions driver
	// is reached by passing `{...model, api: "openai-completions"}` to it.
	// If a host's `streamSimple` cannot handle that api, the call itself
	// errors — that's the right surface, not a load-time warning.
	const warnings: string[] = [];
	for (const spec of PROVIDERS) {
		// `makeProvider` is async because the host-branched direct
		// `registerOAuthProvider` dispatch (S03/M003) is itself a
		// dynamic import. We `await` each call so the deferred-warning
		// buffer is fully populated before the session_start handler is
		// registered below — otherwise an omp-only registration failure
		// could race the handler attachment and be silently lost.
		await makeProvider(pi, spec, overrides.contextWindow, streamSimple, warnings);
	}

	// Surface every deferred warning at session_start. Two producers feed
	// this same handler: the override-file validation errors from S01
	// (`overrides.invalid`) and the fail-soft warnings from S02 (driver
	// missing, registerProvider thrown). They are merged into one
	// session_start handler so the user sees one grouped banner instead
	// of several competing toasts.
	const allWarnings: string[] = warnings.slice();
	for (const err of overrides.invalid) {
		allWarnings.push(
			`m3-clean-overrides: ${err.provider}/${err.modelId}.${err.field} — ${err.reason}. Falling back to default.`,
		);
	}
	if (allWarnings.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			for (const msg of allWarnings) ctx.ui.notify(msg, "warning");
		});
	}
}
