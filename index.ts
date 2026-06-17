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
 * loads on a host that:
 *   (a) does not register the `openai-completions` driver
 *       (`getApiProvider("openai-completions")` returns `undefined`); or
 *   (b) refuses to accept a provider name conflict in
 *       `pi.registerProvider(spec.name, ...)` (validation error throws).
 *
 * The two failure paths are handled as skip+warn:
 *   - The driver is resolved once at extension load. If it is `undefined`,
 *     we record a TUI warning and skip the entire registration loop.
 *   - Each `pi.registerProvider` call is wrapped in try/catch. On throw
 *     we record a TUI warning naming the provider and continue with the
 *     next spec instead of letting the exception propagate.
 *
 * Warnings are deferred to `session_start` because `ctx.ui.notify` is
 * not available in the extension factory — the same precedent S01
 * established for `overrides.invalid` entries.
 *
 * Cross-host notes
 * ----------------
 * The static `import { getApiProvider } from "@earendil-works/pi-ai"`
 * is a known runtime gap on omp (MEM006 — omp exports
 * `getCustomApi`/`registerCustomApi` instead of `getApiProvider`/
 * `registerApiProvider`). T02 only catches the *runtime* case where
 * the import succeeded but the driver is not registered. The
 * static-import gap is the planned S04 slice.
 */

import { getApiProvider } from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cleanStream } from "./src/core/clean-stream";
import { loadOverrides } from "./src/core/overrides";
import { M3_COMPAT, M3_DEFAULTS, PROVIDERS, type ProviderSpec } from "./src/core/providers";

// Pi forks exposing getAgentDir(); first one whose import succeeds wins.
const AGENT_DIR_PROVIDERS = [
	"@earendil-works/pi-coding-agent", // vanilla pi
	"@oh-my-pi/pi-coding-agent", // omp (can1357/oh-my-pi)
	"@gsd/pi-coding-agent", // gsd (open-gsd/gsd-pi)
] as const;

async function resolveAgentDir(): Promise<string | undefined> {
	for (const pkg of AGENT_DIR_PROVIDERS) {
		try {
			const mod = await import(pkg);
			if (typeof mod.getAgentDir === "function") return mod.getAgentDir();
		} catch {
			// Package not installed in this runtime — try the next one.
		}
	}
	return undefined;
}

function makeProvider(
	pi: ExtensionAPI,
	spec: ProviderSpec,
	contextWindow: number,
	driver: ReturnType<typeof getApiProvider>,
	warnings: string[],
): boolean {
	const api = spec.name as Api; // custom api id so only these models hit our handler
	try {
		pi.registerProvider(spec.name, {
			baseUrl: spec.baseUrl,
			apiKey: spec.apiKey,
			api,
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				if (!driver) throw new Error("openai-completions api provider not registered");
				const base = driver.streamSimple({ ...model, api: "openai-completions" }, context, options);
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

	// Resolve the openai-completions driver ONCE at extension load. If the
	// host did not register it (a build where this driver is optional, or
	// a fork that uses a different driver name), record one deferred
	// warning and skip the whole registration loop — there is no point
	// registering a provider whose streamSimple would throw on first call.
	const warnings: string[] = [];
	const driver = getApiProvider("openai-completions");
	if (!driver) {
		warnings.push(
			"m3-clean: openai-completions api provider is not registered on this host. Skipping all provider registrations.",
		);
	} else {
		for (const spec of PROVIDERS) {
			makeProvider(pi, spec, overrides.contextWindow, driver, warnings);
		}
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
