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
 * passes `{...model, api: "openai-completions"}` to reach the
 * openai-completions driver without going through `getApiProvider` (which
 * omp dropped in 16.0.2 — see MEM006).
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

function makeProvider(
	pi: ExtensionAPI,
	spec: ProviderSpec,
	contextWindow: number,
	streamSimpleFn: typeof streamSimple,
	warnings: string[],
): boolean {
	const api = spec.name as Api; // custom api id so only these models hit our handler
	try {
		pi.registerProvider(spec.name, {
			baseUrl: spec.baseUrl,
			apiKey: spec.apiKey,
			api,
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				const base = streamSimpleFn({ ...model, api: "openai-completions" }, context, options);
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
		makeProvider(pi, spec, overrides.contextWindow, streamSimple, warnings);
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
