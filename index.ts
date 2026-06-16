/**
 * minimax-m3-clean — MiniMax-M3 on the OpenAI-compatible endpoint with
 * clean streaming output.
 *
 * Why this exists
 * ---------------
 * pi 0.79.1 routes the built-in `minimax / MiniMax-M3` to the Anthropic-
 * compatible endpoint, which silently ignores `cache_control` (full input
 * price every turn). The OpenAI-compatible endpoint (`/v1/chat/completions`)
 * does passive caching — but there M3 has two streaming quirks:
 *
 *   1. It emits thinking twice: in `reasoning_content`/`reasoning` fields
 *      (consumed by pi as thinking blocks) and again inline in `content` as
 *      `<think>…</think>`, which pollutes the visible text.
 *   2. It alternates between `reasoning_content` and `reasoning` across
 *      chunks. pi-ai's openai-completions driver starts a NEW thinking block
 *      whenever the field (signature) changes, producing a truncated orphan
 *      thinking block followed by a second block that re-streams the
 *      reasoning from the start.
 *
 * The upstream fix (earendil-works/pi commit b85b91c9, `skipThinkingBlock`)
 * is not merged/released as of 0.79.1, and the community extension
 * `rwese/pi-minimax-m3-caching-fix` only strips the `<think>` duplicate at
 * `message_end`, after it was visible during the whole stream.
 *
 * This extension fixes both at the stream level: it registers providers
 * whose `streamSimple` delegates to the built-in openai-completions driver
 * and rewrites the event stream in flight:
 *
 *   - All driver thinking blocks are merged into ONE thinking block.
 *     Re-streamed duplicate content (prefix overlap) is suppressed; only
 *     genuinely new reasoning is emitted.
 *   - `<think>…</think>` spans are filtered out of text deltas in real time
 *     (handles markers split across deltas). If the model never streamed
 *     reasoning fields, the `<think>` content is re-routed into a real
 *     thinking block instead of being dropped.
 *   - Visible text starts only at its first non-whitespace character, so no
 *     empty/whitespace text blocks are rendered.
 *   - Tool calls, usage, and stop reasons pass through untouched.
 *
 * Removal: when a pi release ships MiniMax-M3 on `openai-completions` with
 * `skipThinkingBlock` (upstream b85b91c9), delete this file and switch back
 * to the built-in `minimax / MiniMax-M3` via /model.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	getApiProvider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Incremental scanner that splits a text stream into visible text and
 * `<think>…</think>` inner content. Tags split across deltas are held back
 * until they can be classified.
 */
class ThinkScanner {
	private buf = "";
	private inThink = false;

	feed(chunk: string): { text: string; think: string } {
		let text = "";
		let think = "";
		const s = this.buf + chunk;
		this.buf = "";
		let i = 0;
		while (i < s.length) {
			const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
			const idx = s.indexOf(tag, i);
			if (idx !== -1) {
				const piece = s.slice(i, idx);
				if (this.inThink) think += piece;
				else text += piece;
				this.inThink = !this.inThink;
				i = idx + tag.length;
			} else {
				const keep = partialTagSuffix(s, i, tag);
				const piece = s.slice(i, s.length - keep);
				if (this.inThink) think += piece;
				else text += piece;
				this.buf = s.slice(s.length - keep);
				i = s.length;
			}
		}
		return { text, think };
	}

	/** Flush held-back bytes at end of block. An unterminated `<think>` stays thinking. */
	flush(): { text: string; think: string } {
		const rest = this.buf;
		this.buf = "";
		if (!rest) return { text: "", think: "" };
		return this.inThink ? { text: "", think: rest } : { text: rest, think: "" };
	}
}

/** Longest k < tag.length such that s (from `from`) ends with tag.slice(0, k). */
function partialTagSuffix(s: string, from: number, tag: string): number {
	const max = Math.min(tag.length - 1, s.length - from);
	for (let k = max; k > 0; k--) {
		if (s.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

interface TextState {
	scanner: ThinkScanner;
	started: boolean;
	index: number;
	block: TextContent;
}

interface ThinkingSegment {
	block: ThinkingContent;
	index: number;
	open: boolean;
	/** Leading-whitespace-trimmed accumulated thinking text (what was emitted). */
	text: string;
	signature?: string;
}

/**
 * Wrap the built-in openai-completions stream, rewriting events so that
 * `<think>` content never reaches a visible text block and duplicated /
 * re-streamed reasoning collapses into a single thinking block.
 */
function cleanStream(
	base: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	void (async () => {
		let output: AssistantMessage | undefined;
		const toolIndexMap = new Map<number, number>();
		const textStates = new Map<number, TextState>();
		/** Accumulated text per base thinking block, for prefix dedupe. */
		const baseThinkingAccs = new Map<number, string>();
		let sawBaseThinking = false;
		let segment: ThinkingSegment | undefined;

		const ensureOutput = (partial: AssistantMessage): AssistantMessage => {
			if (!output) output = { ...partial, content: [] };
			return output;
		};

		// The base driver mutates its partial in place; mirror everything but
		// content (usage, stopReason, responseId, …) onto our partial.
		const syncMeta = (partial: AssistantMessage) => {
			if (!output) {
				ensureOutput(partial);
				return;
			}
			for (const key of Object.keys(partial)) {
				if (key === "content") continue;
				(output as unknown as Record<string, unknown>)[key] = (
					partial as unknown as Record<string, unknown>
				)[key];
			}
		};

		const ensureSegment = (): ThinkingSegment => {
			if (segment?.open) return segment;
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output!.content.push(block);
			segment = {
				block,
				index: output!.content.length - 1,
				open: true,
				text: "",
			};
			baseThinkingAccs.clear();
			out.push({
				type: "thinking_start",
				contentIndex: segment.index,
				partial: output!,
			});
			return segment;
		};

		const closeSegment = () => {
			if (!segment?.open) return;
			segment.open = false;
			segment.text = segment.text.trimEnd();
			segment.block.thinking = segment.text;
			if (segment.signature) {
				(
					segment.block as ThinkingContent & { thinkingSignature?: string }
				).thinkingSignature = segment.signature;
			}
			out.push({
				type: "thinking_end",
				contentIndex: segment.index,
				content: segment.text,
				partial: output!,
			});
		};

		/** Append already-deduped thinking text to the current segment. */
		const appendThinking = (delta: string) => {
			if (!delta || !output) return;
			const seg = ensureSegment();
			if (seg.text === "") {
				delta = delta.replace(/^\s+/, "");
				if (!delta) return;
			}
			seg.text += delta;
			seg.block.thinking = seg.text;
			out.push({
				type: "thinking_delta",
				contentIndex: seg.index,
				delta,
				partial: output,
			});
		};

		/**
		 * Thinking from a base thinking block. M3 re-streams the same
		 * reasoning when the driver switches reasoning fields, so emit only
		 * the part that extends what the current segment already holds.
		 */
		const pushBaseThinking = (contentIndex: number, delta: string) => {
			const acc = (baseThinkingAccs.get(contentIndex) ?? "") + delta;
			baseThinkingAccs.set(contentIndex, acc);
			const seg = segment?.open ? segment : undefined;
			const have = seg?.text ?? "";
			const norm = acc.replace(/^\s+/, "");
			if (norm.length <= have.length) {
				// Duplicate prefix of what we already emitted → suppress.
				if (have.startsWith(norm)) return;
				appendThinking(delta);
			} else if (norm.startsWith(have)) {
				appendThinking(norm.slice(have.length));
			} else {
				appendThinking(delta);
			}
		};

		/** Thinking recovered from inline `<think>…</think>` markers. */
		const pushInlineThinking = (think: string) => {
			// If the model streams real reasoning fields, the <think> copy is a
			// duplicate — drop it.
			if (!think || sawBaseThinking || !output) return;
			appendThinking(think);
		};

		const pushText = (state: TextState, text: string) => {
			if (!text || !output) return;
			if (!state.started) {
				text = text.replace(/^\s+/, "");
				if (!text) return;
				closeSegment();
				output.content.push(state.block);
				state.index = output.content.length - 1;
				state.started = true;
				out.push({
					type: "text_start",
					contentIndex: state.index,
					partial: output,
				});
			}
			state.block.text += text;
			out.push({
				type: "text_delta",
				contentIndex: state.index,
				delta: text,
				partial: output,
			});
		};

		try {
			for await (const ev of base) {
				switch (ev.type) {
					case "start": {
						ensureOutput(ev.partial);
						out.push({ type: "start", partial: output! });
						break;
					}
					case "thinking_start": {
						sawBaseThinking = true;
						syncMeta(ev.partial);
						baseThinkingAccs.set(ev.contentIndex, "");
						break;
					}
					case "thinking_delta": {
						syncMeta(ev.partial);
						pushBaseThinking(ev.contentIndex, ev.delta);
						break;
					}
					case "thinking_end": {
						syncMeta(ev.partial);
						// Don't close the merged segment: the driver may open a
						// follow-up block that continues the same reasoning. Just
						// remember the signature for the final block.
						const baseBlock = ev.partial.content[ev.contentIndex] as
							| (ThinkingContent & { thinkingSignature?: string })
							| undefined;
						if (
							segment &&
							baseBlock?.type === "thinking" &&
							baseBlock.thinkingSignature
						) {
							segment.signature = baseBlock.thinkingSignature;
						}
						break;
					}
					case "text_start": {
						syncMeta(ev.partial);
						// Don't emit yet: the block may turn out to be pure <think>
						// content. text_start fires on the first visible character.
						textStates.set(ev.contentIndex, {
							scanner: new ThinkScanner(),
							started: false,
							index: -1,
							block: { type: "text", text: "" },
						});
						break;
					}
					case "text_delta": {
						syncMeta(ev.partial);
						const state = textStates.get(ev.contentIndex);
						if (!state) break;
						const { text, think } = state.scanner.feed(ev.delta);
						pushInlineThinking(think);
						pushText(state, text);
						break;
					}
					case "text_end": {
						syncMeta(ev.partial);
						const state = textStates.get(ev.contentIndex);
						if (!state) break;
						const tail = state.scanner.flush();
						pushInlineThinking(tail.think);
						pushText(state, tail.text);
						if (state.started) {
							state.block.text = state.block.text.trimEnd();
							out.push({
								type: "text_end",
								contentIndex: state.index,
								content: state.block.text,
								partial: output!,
							});
						}
						break;
					}
					case "toolcall_start": {
						syncMeta(ev.partial);
						closeSegment();
						const baseBlock = ev.partial.content[ev.contentIndex];
						output!.content.push(
							baseBlock as AssistantMessage["content"][number],
						);
						toolIndexMap.set(ev.contentIndex, output!.content.length - 1);
						out.push({
							type: "toolcall_start",
							contentIndex: toolIndexMap.get(ev.contentIndex)!,
							partial: output!,
						});
						break;
					}
					case "toolcall_delta": {
						syncMeta(ev.partial);
						const idx = toolIndexMap.get(ev.contentIndex);
						if (idx === undefined) break;
						out.push({
							type: "toolcall_delta",
							contentIndex: idx,
							delta: ev.delta,
							partial: output!,
						});
						break;
					}
					case "toolcall_end": {
						syncMeta(ev.partial);
						const idx = toolIndexMap.get(ev.contentIndex);
						if (idx === undefined) break;
						output!.content[idx] = ev.toolCall;
						out.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall: ev.toolCall,
							partial: output!,
						});
						break;
					}
					case "done": {
						closeSegment();
						const message: AssistantMessage = {
							...ev.message,
							content: output ? output.content : ev.message.content,
						};
						out.push({ type: "done", reason: ev.reason, message });
						break;
					}
					case "error": {
						closeSegment();
						const error: AssistantMessage = {
							...ev.error,
							content: output ? output.content : ev.error.content,
						};
						out.push({ type: "error", reason: ev.reason, error });
						break;
					}
				}
			}
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			const fallback: AssistantMessage = output ?? {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "minimax-m3-clean",
				model: "MiniMax-M3",
				usage: {} as AssistantMessage["usage"],
				stopReason: "error",
				timestamp: Date.now(),
			};
			out.push({
				type: "error",
				reason: "error",
				error: { ...fallback, stopReason: "error", errorMessage },
			});
		}
	})();

	return out;
}

const M3_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens" as const,
};

/** Built-in defaults. Used when `m3-clean-overrides.json` is missing or a
 *  field is not present in it. */
const M3_DEFAULTS = {
	contextWindow: 1_000_000,
	maxTokens: 512_000,
	cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
} as const;

const OVERRIDES_FILE = "m3-clean-overrides.json";

/** Per-model entry in `m3-clean-overrides.json`. Only `contextWindow` is
 *  honored — full model replacement (cost, compat, etc.) is what
 *  `~/.pi/agent/models.json` is for. */
interface ModelOverride {
	contextWindow?: number;
}

type OverridesFile = Record<string, Record<string, ModelOverride>>;

/**
 * Packages known to expose `getAgentDir()`. The first one whose import
 * succeeds wins. Add new Pi forks here. If none is installed, we silently
 * skip the override file and use built-in defaults.
 */
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

interface InvalidEntry {
	provider: string;
	modelId: string;
	field: string;
	reason: string;
}

interface LoadedOverrides {
	contextWindow: number;
	invalid: InvalidEntry[];
}

/** Read the override file and return the merged `contextWindow` plus a list
 *  of validation errors to surface via TUI at `session_start`. */
async function loadOverrides(agentDir: string): Promise<LoadedOverrides> {
	const result: LoadedOverrides = {
		contextWindow: M3_DEFAULTS.contextWindow,
		invalid: [],
	};
	let parsed: OverridesFile;
	try {
		const text = await readFile(join(agentDir, OVERRIDES_FILE), "utf8");
		parsed = JSON.parse(text);
	} catch {
		// File missing, unreadable, or invalid JSON — silent fallback to defaults.
		return result;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return result;
	}
	// Both providers share the same model id and the same context-window
	// limit (M3 is one model). We honor only the first valid value across
	// the file; mixing different `contextWindow` per provider would be
	// surprising. If the user really needs split, they can override per
	// provider in their own `models.json` (full model replacement).
	let chosen: number | undefined;
	for (const [provider, models] of Object.entries(parsed)) {
		if (!models || typeof models !== "object") continue;
		for (const [modelId, override] of Object.entries(models)) {
			if (!override || typeof override !== "object") continue;
			if (override.contextWindow === undefined) continue;
			if (
				typeof override.contextWindow !== "number" ||
				!Number.isFinite(override.contextWindow) ||
				override.contextWindow <= 0
			) {
				result.invalid.push({
					provider,
					modelId,
					field: "contextWindow",
					reason: `expected positive number, got ${JSON.stringify(override.contextWindow)}`,
				});
				continue;
			}
			if (chosen === undefined) chosen = override.contextWindow;
		}
	}
	if (chosen !== undefined) result.contextWindow = chosen;
	return result;
}

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

function makeProvider(
	pi: ExtensionAPI,
	spec: ProviderSpec,
	contextWindow: number,
) {
	const api = spec.name as Api; // custom api id so only these models hit our handler
	pi.registerProvider(spec.name, {
		baseUrl: spec.baseUrl,
		apiKey: spec.apiKey,
		api,
		streamSimple: (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => {
			const driver = getApiProvider("openai-completions");
			if (!driver)
				throw new Error("openai-completions api provider not registered");
			const base = driver.streamSimple(
				{ ...model, api: "openai-completions" },
				context,
				options,
			);
			return cleanStream(base);
		},
		models: [
			{
				id: "MiniMax-M3",
				name: spec.label,
				reasoning: true,
				input: ["text", "image"],
				cost: { ...M3_DEFAULTS.cost },
				contextWindow,
				maxTokens: M3_DEFAULTS.maxTokens,
				compat: M3_COMPAT,
			},
		],
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
		pi.on("session_start", ((
			_event: unknown,
			ctx: { ui: { notify: (msg: string, kind: string) => void } },
		) => {
			for (const err of invalid) {
				ctx.ui.notify(
					`m3-clean-overrides: ${err.provider}/${err.modelId}.${err.field} — ${err.reason}. Falling back to default.`,
					"error",
				);
			}
		}) as Parameters<typeof pi.on>[1]);
	}
}
