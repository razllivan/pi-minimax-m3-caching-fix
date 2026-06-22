/**
 * OAuth registration helper for the M3 providers.
 *
 * Why this is registration-shape only
 * -----------------------------------
 * omp 16.0.2 surfaces our providers in its `/login` selector iff the
 * `oauth: { name, login, refreshToken, getApiKey }` block is passed into
 * `pi.registerProvider` (verified at `dist/cli.js`: `if (config3.oauth) registerOAuthProvider(...)`).
 * Vanilla pi 0.79.1 and the gsd fork accept the same shape at the type
 * level (their `ProviderConfig.oauth` is `Omit<OAuthProviderInterface, "id">`
 * in `@earendil-works/pi-coding-agent@0.79.1`'s `dist/core/extensions/types.d.ts:983`),
 * but expose their own native `/login` API-key picker, so users on those
 * hosts will not click our oauth entry. We deliberately do NOT branch on
 * the host at runtime: the same `OauthConfig` is handed to every host, and
 * the hosts that don't recognize it simply skip the registration block.
 *
 * Why the type satisfies `OAuthProviderInterface` (revised S01/M003 T03)
 * ---------------------------------------------------------------------
 * The original T01 design used a narrow `{name, login}` shape based on
 * omp's permissive `Promise<OAuthCredentials | string>` login signature.
 * Vanilla pi 0.79.1 has a stricter type — its `ProviderConfig.oauth`
 * requires `login` to return `Promise<OAuthCredentials>` plus the methods
 * `refreshToken` and `getApiKey`. Passing our narrow shape through
 * `pi.registerProvider({oauth})` therefore fails `tsc` with TS2739 before
 * the S02 fail-soft `try/catch` ever runs. The T03 plan assumed vanilla
 * pi would reject the shape only at runtime, but `tsc` catches it at
 * compile time. Resolution: widen `OauthConfig` to satisfy both hosts'
 * shapes by wrapping the pasted API key in `{access: key, refresh: key,
 * expires: 0}` and adding `refreshToken`/`getApiKey` no-ops (paste-flow
 * logins never refresh — the user re-prompts if their key changes).
 *
 * Why the callback uses `callbacks.onPrompt`, not `ctx.ui`
 * --------------------------------------------------------
 * The login callback is invoked by `AuthStorage.login({onPrompt, ...})` AT
 * LOGIN TIME — long after the extension factory has returned and the
 * factory's `ctx.ui` reference is `undefined`. The callback MUST close
 * over the host-injected `onPrompt` channel, not over any reference
 * captured during factory execution. The hermetic regression check in
 * T04 anchors this with a static source assertion (no live `ctx.ui`
 * reference in this file — the docblock mentions of `ctx.ui` explain the
 * anti-pattern and are not code).
 *
 * Documented asymmetry
 * --------------------
 * pi/gsd users will not click our `/login` oauth entry because their
 * native API-key picker is what they use. omp users get our providers
 * listed in `/login` and the API key is recovered by omp's `AuthStorage`
 * via `getApiKey(credentials) → credentials.access` (omp's
 * `OAuthProviderInterface.login` types the return as `Promise<OAuthCredentials
 * | string>`, but both hosts funnel through `getApiKey` for the persisted
 * key string). See AGENTS.md §3 for the cross-host oauth registration shape.
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ProviderSpec } from "./providers";

/** Narrow callback surface we actually use. The host passes a richer
 *  `OAuthLoginCallbacks` (with onAuth/onDeviceCode/onSelect/etc.), but
 *  the paste-an-API-key flow only needs `onPrompt`. Declared locally
 *  rather than imported so the contract is decoupled from any specific
 *  host's `OAuthLoginCallbacks` export. */
export type OauthPromptCallbacks = {
	onPrompt: (prompt: { message: string }) => Promise<string>;
};

/** OAuth registration shape we hand to `pi.registerProvider`. Structurally
 *  matches `Omit<OAuthProviderInterface, "id">` (which is what
 *  `@earendil-works/pi-coding-agent@0.79.1`'s `ProviderConfig.oauth`
 *  requires). omp 16.0.2's `OAuthProviderInterface` declares
 *  `refreshToken`/`getApiKey` as optional, so this shape is a superset of
 *  what omp strictly needs. */
export interface OauthConfig {
	name: string;
	login: (callbacks: OauthPromptCallbacks) => Promise<OAuthCredentials>;
	/** Paste-flow logins don't refresh — the user re-prompts if their key
	 *  changes. Returning the same credentials is the documented no-op. */
	refreshToken: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
	/** Extract the persisted API key from the credentials object. omp's
	 *  AuthStorage funnels through this to recover the key string. */
	getApiKey: (credentials: OAuthCredentials) => string;
}

/** Minimal structural shape `oauthConfigFor` reads from its input. Widening
 *  beyond `ProviderSpec` lets the providers module pass seed entries that
 *  have not yet been decorated with their `oauth` block — the factory only
 *  needs `apiKey` and `label` to compute the env-var hint and display name. */
export interface OauthConfigInput {
	apiKey: string;
	label: string;
}

export function oauthConfigFor(spec: OauthConfigInput & Pick<ProviderSpec, "name">): OauthConfig {
	const envVarName = spec.apiKey.slice(1);
	return {
		name: spec.label,
		login: async (callbacks) => {
			const key = await callbacks.onPrompt({
				message: `Paste your ${envVarName} for ${spec.label}. Input is hidden.`,
			});
			if (!key) throw new Error("API key required");
			// Wrap the pasted key into the OAuthCredentials shape both
			// hosts expect. `access` is the field `getApiKey` returns;
			// `refresh` mirrors the key because paste-flow never refreshes;
			// `expires: 0` signals "no expiry tracking".
			return { access: key, refresh: key, expires: 0 };
		},
		refreshToken: async (credentials) => credentials,
		getApiKey: (credentials) => credentials.access,
	};
}