/**
 * MiniMax-M3 stream wrapper — `ThinkScanner` + `cleanStream`.
 *
 * Why this exists
 * ---------------
 * S01 refactor: lift the stream wrapper (largest piece of the extension,
 * ~290 lines) out of `index.ts` into a dedicated module. The wrapper
 * rewrites the built-in openai-completions event stream in flight —
 * merges driver thinking blocks into one, strips `<think>` duplicates, and
 * only starts visible text at its first non-whitespace character.
 *
 * This file has zero imports from other core modules (./providers,
 * ./overrides). It depends only on `@earendil-works/pi-ai` types and the
 * `createAssistantMessageEventStream` factory. `makeProvider` (which uses
 * `getApiProvider` and `cleanStream`) stays in `index.ts` for now; T04 is
 * the actual swap step that wires this file into the entry point. Until
 * then `index.ts` and `clean-stream.ts` each define their own copy of the
 * symbols — tsc does not flag re-declarations across separate files
 * because each file is its own module scope.
 */

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

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

export { ThinkScanner, cleanStream };
