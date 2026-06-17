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

function makeProvider(pi: ExtensionAPI, spec: ProviderSpec, contextWindow: number) {
	const api = spec.name as Api; // custom api id so only these models hit our handler
	pi.registerProvider(spec.name, {
		baseUrl: spec.baseUrl,
		apiKey: spec.apiKey,
		api,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			const driver = getApiProvider("openai-completions");
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
}

export default async function (pi: ExtensionAPI) {
	const agentDir = await resolveAgentDir();
	const overrides = agentDir
		? await loadOverrides(agentDir)
		: { contextWindow: M3_DEFAULTS.contextWindow, invalid: [] };

	for (const spec of PROVIDERS) makeProvider(pi, spec, overrides.contextWindow);

	// Surface validation errors via TUI. A missing file is silent — only
	// malformed entries get notified. `ctx` is not available in the factory,
	// so defer to `session_start`.
	if (overrides.invalid.length > 0) {
		const invalid = overrides.invalid;
		pi.on("session_start", (_event, ctx) => {
			for (const err of invalid) {
				ctx.ui.notify(
					`m3-clean-overrides: ${err.provider}/${err.modelId}.${err.field} — ${err.reason}. Falling back to default.`,
					"error",
				);
			}
		});
	}
}
