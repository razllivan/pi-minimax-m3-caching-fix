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
 * S05 addition: `streamIdleTimeoutMs: 30_000` is now part of `M3_COMPAT`.
 * omp 16.0.2's openai-completions driver enforces
 * `model.compat.streamIdleTimeoutMs` and errors with "undefined is not an
 * object" at the first request when the field is missing (MEM017; surfaced
 * in S04 T04 evidence record 150700a3). Vanilla `@earendil-works/pi-ai@0.79.1`
 * ignores the field, so this is a safe additive change for vanilla pi users.
 *
 * S01/M003 addition: each entry now carries an `oauth` block.
 * `oauth.login` is a closure over `callbacks.onPrompt` (NOT `ctx.ui`) so the
 * prompt dialog is host-rendered at `/login` time. On omp, returning a
 * string from `login` is persisted as `api_key`; on pi/gsd, users continue
 * to use the host's native `/login` API-key picker (our oauth entry exists
 * for omp and is harmlessly ignored by pi/gsd).
 *
 * Runtime contract risk (vanilla pi): `registerProvider`'s `oauth` shape in
 * `@earendil-works/pi-coding-agent` is typed as
 * `Omit<OAuthProviderInterface, "id">`, which requires `login`,
 * `refreshToken`, and `getApiKey`. Our local `OauthConfig` only declares
 * `name + login`, so on vanilla pi 0.79.1 `pi.registerProvider(name, {
 * oauth })` will reject the shape at validation time. The S02 fail-soft
 * machinery catches that throw and defers a `session_start` warning
 * naming the provider — no crash, just a no-op registration on pi/gsd.
 * omp's `OAuthProvider` accepts the narrow `{name, login}` shape (verified
 * by S02 UAT).
 *
 * The constants here are unchanged from the previous `index.ts` definition
 * (verbatim move). `import type Api` is added in anticipation of T02/T03
 * work that will move `makeProvider` (which uses `Api` and `Model<Api>`)
 * into this module — adding the import now keeps the eventual T02/T03 diffs
 * purely about the new imports, not about widening the type surface.
 */

import type { Api } from "@earendil-works/pi-ai";
import { oauthConfigFor } from "./oauth-login";
import type { OauthConfig } from "./oauth-login";

/** Driver compatibility flags for MiniMax-M3 on the OpenAI-compatible
 *  endpoint. `supportsStore: false` is what enables the extension's whole
 *  reason for being — it keeps the request off pi-ai's `anthropic-messages`
 *  cache control path. `streamIdleTimeoutMs: 30_000` is required by omp's
 *  openai-completions driver (per MEM017); vanilla pi 0.79.1 ignores the
 *  field, so it is a safe additive change. */
export const M3_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
	streamIdleTimeoutMs: 30_000,
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

export interface ProviderSpec {
	name: string;
	baseUrl: string;
	apiKey: string;
	label: string;
	/** Cross-host login descriptor. Required (not optional) so a future
	 *  `PROVIDERS` entry cannot accidentally ship without one. See the
	 *  file header for the per-host contract. */
	oauth: OauthConfig;
}

interface ProviderSpecSeed {
	name: string;
	baseUrl: string;
	apiKey: string;
	label: string;
}

const PROVIDER_SEEDS: readonly ProviderSpecSeed[] = [
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

/** Final, immutable provider list with `oauth` blocks attached. The
 *  `.map(s => ({ ...s, oauth: oauthConfigFor(s) }))` pattern lets us keep
 *  the seeds readable as plain object literals (no self-reference TS
 *  narrowing issues) while still producing entries that satisfy the
 *  `ProviderSpec` interface. */
export const PROVIDERS: readonly ProviderSpec[] = PROVIDER_SEEDS.map((s) => ({
	...s,
	oauth: oauthConfigFor(s),
}));
