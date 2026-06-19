/**
 * Override-file parser for `m3-clean-overrides.json`.
 *
 * Why this exists
 * ---------------
 * S01 refactor: the override parser is the only core module that has a
 * cross-module dependency (it imports `M3_DEFAULTS` from `./providers.ts`
 * to seed the default `contextWindow` before merging the user's file).
 * Doing it second in the slice means `providers.ts` is already stable and
 * the import edge is one-way.
 *
 * `AGENT_DIR_PROVIDERS` and `resolveAgentDir()` are intentionally NOT
 * here — those locate the file on disk, not parse it. They stay in
 * `index.ts` for now and will be revisited during a later slice if a
 * second consumer needs them.
 *
 * The bodies below are unchanged from the previous `index.ts` definition
 * (verbatim move). The `import M3_DEFAULTS` is the only addition.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { M3_DEFAULTS } from "./providers";

const OVERRIDES_FILE = "m3-clean-overrides.json";

/** Per-model entry in `m3-clean-overrides.json`. Only `contextWindow` is
 *  honored — full model replacement (cost, compat, etc.) is what
 *  `~/.pi/agent/models.json` is for. */
export interface ModelOverride {
	contextWindow?: number;
}

export type OverridesFile = Record<string, Record<string, ModelOverride>>;

export interface InvalidEntry {
	provider: string;
	modelId: string;
	field: string;
	reason: string;
}

export interface LoadedOverrides {
	contextWindow: number;
	invalid: InvalidEntry[];
}

/** Read the override file and return the merged `contextWindow` plus a list
 *  of validation errors to surface via TUI at `session_start`. */
export async function loadOverrides(
	agentDir: string,
): Promise<LoadedOverrides> {
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
				override.contextWindow <= 0 ||
				!Number.isInteger(override.contextWindow)
			) {
				result.invalid.push({
					provider,
					modelId,
					field: "contextWindow",
					reason: `expected positive integer, got ${JSON.stringify(override.contextWindow)}`,
				});
				continue;
			}
			if (chosen === undefined) chosen = override.contextWindow;
		}
	}
	if (chosen !== undefined) result.contextWindow = chosen;
	return result;
}
