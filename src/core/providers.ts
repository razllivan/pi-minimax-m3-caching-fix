/**
 * MiniMax-M3 provider metadata — pure constants, no runtime side effects.
 *
 * Why this exists
 * ---------------
 * S01 refactor: lift the four pure-constant exports (`M3_COMPAT`,
 * `M3_DEFAULTS`, `ProviderSpec`, `PROVIDERS`) out of `index.ts` into a
 * dedicated module. Because this file has zero imports from any other core
 * module, it has no circular-dependency surface — `overrides.ts` (T02) can
 * safely import `M3_DEFAULTS` from here, and `clean-stream.ts` (T03) does
 * not touch this file at all.
 *
 * The constants here are unchanged from the previous `index.ts` definition
 * (verbatim move). `import type Api` is added in anticipation of T02/T03
 * work that will move `makeProvider` (which uses `Api` and `Model<Api>`)
 * into this module — adding the import now keeps the eventual T02/T03 diffs
 * purely about the new imports, not about widening the type surface.
 */

import type { Api } from "@earendil-works/pi-ai";

/** Driver compatibility flags for MiniMax-M3 on the OpenAI-compatible
 *  endpoint. `supportsStore: false` is what enables the extension's whole
 *  reason for being — it keeps the request off pi-ai's `anthropic-messages`
 *  cache control path. */
const M3_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
};

/** Built-in defaults. Used when `m3-clean-overrides.json` is missing or a
 *  field is not present in it. Exported because `overrides.ts` needs to
 *  seed the result with `M3_DEFAULTS.contextWindow` before merging the
 *  user's override file. */
export const M3_DEFAULTS = {
	contextWindow: 1_000_000,
	maxTokens: 512_000,
	cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
} as const;

interface ProviderSpec {
	name: string;
	baseUrl: string;
	apiKey: string;
	label: string;
}

const PROVIDERS: readonly ProviderSpec[] = [
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
