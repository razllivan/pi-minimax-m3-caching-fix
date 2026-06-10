/**
 * pi-minimax-m3 — register MiniMax-M3 on the OpenAI-compatible endpoint
 *
 * Background
 * ----------
 * The built-in `minimax` provider in pi routes MiniMax-M3 to the Anthropic
 * Messages-compatible endpoint (`/anthropic/v1/messages`). M3 silently ignores
 * `cache_control` markers on that endpoint, so every turn is billed at full
 * input price ($0.60/Mtok) instead of cache-read price ($0.12/Mtok).
 *
 * M3 does support passive/automatic caching on its OpenAI-compatible endpoint
 * (`/v1/chat/completions`). Routing M3 to that endpoint — and removing the
 * thinking-duplication bug — is the upstream fix in `pi-mono@b85b91c9`.
 *
 * This extension reproduces the routing fix for any pi version: it registers
 * two new providers (`minimax-m3-cache-fixed`, `minimax-cn-m3-cache-fixed`)
 * that point at the OpenAI-compatible M3 base URLs.
 *
 * Why a separate provider (not overriding the built-in)
 * -----------------------------------------------------
 * `pi.registerProvider(name, { models })` REPLACES every model for that
 * provider. Overriding `minimax` would wipe M2.x. Overriding only the URL
 * would lump M2.x onto the OpenAI-compat endpoint. So we register new
 * provider names instead.
 *
 * Thinking duplication
 * --------------------
 * M3 emits thinking twice: once in `reasoning_content` (consumed by pi as a
 * thinking block) and once in `content` wrapped in <think>…</think> markers
 * (which lands in the visible text block).
 *
 * The upstream fix adds a `compat.skipThinkingBlock` flag to
 * `OpenAICompletionsCompat` in pi-ai. The latest published pi-ai (0.79.1) does
 * not yet have this flag — it lands in the next release. To fix the
 * duplication today, this extension intercepts the finalized assistant message
 * via the `message_end` event and:
 *   1. drops any `thinking` content blocks
 *   2. strips <think>…</think> (and any inner content) from `text` blocks
 *
 * Trade-off: the duplication is visible during streaming and only cleaned up
 * at the end of the turn. The TUI replaces the message in place at
 * `message_end`, so the saved session log is clean.
 *
 * Removal
 * -------
 * When pi-mono ships a pi-ai release that includes `skipThinkingBlock` (and
 * routes M3 to openai-completions in `models.generated.ts`), uninstall this
 * extension and switch back to the built-in `minimax / MiniMax-M3`.
 */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai";

/** Provider names this extension owns. */
const OWN_PROVIDERS = new Set(["minimax-m3-cache-fixed", "minimax-cn-m3-cache-fixed"]);

/**
 * MiniMax-M3 model metadata.
 *
 * `contextWindow: 1_000_000` and `maxTokens: 512_000` match the published M3
 * spec (the upstream `models.generated.ts` for the built-in provider lists
 * 512K/128K, which is a more conservative cap that the OpenAI-compat endpoint
 * does not enforce). The user's existing `~/.pi/agent/models.json` uses the
 * 1M/512K pair against `https://api.minimax.io/v1`, so we match that.
 *
 * The compat block matches the upstream M3 fix; `skipThinkingBlock` is
 * intentionally NOT set because the user's installed pi-ai predates that
 * field. The thinking-strip happens in the `message_end` hook below.
 */
const M3_COST = { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 };
const M3_LIMITS = { contextWindow: 1_000_000, maxTokens: 512_000 };

/**
 * Compat flags for OpenAI-completions against MiniMax-M3.
 *
 * Modeled after the `OpenAICompletionsCompat` shape in pi-ai but written as
 * a local constant because `ProviderModelConfig["compat"]` is typed
 * `Model<Api>["compat"]` — a union over every API — and pi-ai@0.79.1's union
 * member for `openai-completions` (`ResolvedOpenAICompletionsCompat`) is the
 * post-resolution shape, not the author-facing input. The author-facing
 * shape accepts partial input; the keys below are exactly what the upstream
 * M3 entry uses. Extra unknown keys are rejected by the validator in
 * `ModelRegistry.validateProviderConfig`; missing keys are filled in by
 * `applyProviderConfig`'s defaults. We only need to list the ones that
 * differ from the defaults.
 */
const M3_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

function makeM3Model(suffix: string): ProviderModelConfig {
	return {
		id: "MiniMax-M3",
		name: `MiniMax-M3 (cache-fixed${suffix})`,
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		cost: M3_COST,
		contextWindow: M3_LIMITS.contextWindow,
		maxTokens: M3_LIMITS.maxTokens,
		compat: M3_COMPAT,
	};
}

function makeProviderConfig(
	baseUrl: string,
	apiKey: string,
	suffix: string,
): ProviderConfig {
	return {
		baseUrl,
		apiKey,
		api: "openai-completions",
		models: [makeM3Model(suffix)],
	};
}

/**
 * Strip <think>…</think> blocks (including any inner content) from a string.
 *
 * Mirrors the upstream `openai-completions.ts` regex:
 *   `text.replace(/<think>[\s\S]*?<\/think>/g, "")`
 * plus a final pass that also catches unclosed `<think>` markers (defensive
 * against split-across-deltas edge cases).
 */
function stripThinkMarkers(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "").trim();
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: string }).role === "assistant"
	);
}

function isTextBlock(block: unknown): block is TextContent {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: string }).type === "text"
	);
}

function isThinkingBlock(block: unknown): block is ThinkingContent {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: string }).type === "thinking"
	);
}

export default function (pi: ExtensionAPI) {
	// --- Provider registration (T2: passive-cache routing) -----------------

	pi.registerProvider(
		"minimax-m3-cache-fixed",
		makeProviderConfig("https://api.minimax.io/v1", "$MINIMAX_API_KEY", ""),
	);

	pi.registerProvider(
		"minimax-cn-m3-cache-fixed",
		makeProviderConfig("https://api.minimaxi.com/v1", "$MINIMAX_CN_API_KEY", " — CN"),
	);

	// --- Thinking-strip hook -----------------------------------------------

	pi.on("message_end", (event) => {
		const { message } = event;
		if (!isAssistantMessage(message)) return;
		if (!OWN_PROVIDERS.has(message.provider)) return;

		// Replace thinking blocks with empty text blocks (keeps the content
		// array shape) and strip <think>…</think> markers from text blocks.
		// Returns undefined when nothing changed so the agent session log
		// stays untouched.
		const original = message.content;
		const cleaned: AssistantMessage["content"] = [];
		let mutated = false;

		for (const block of original) {
			if (isThinkingBlock(block)) {
				// Drop the thinking block entirely. The thinking was already
				// shown to the user via the live TUI; we don't need a stub.
				mutated = true;
				continue;
			}
			if (isTextBlock(block)) {
				const cleanedText = stripThinkMarkers(block.text);
				if (cleanedText !== block.text) {
					mutated = true;
					cleaned.push({ ...block, text: cleanedText });
				} else {
					cleaned.push(block);
				}
				continue;
			}
			cleaned.push(block);
		}

		if (!mutated) return undefined;

		return { message: { ...message, content: cleaned } };
	});
}
