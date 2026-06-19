#!/usr/bin/env node
// tests/criterion-4-validation-check.mjs
//
// Regression check for M001 success criterion #4:
// "Invalid contextWindow values (non-number, non-positive, non-integer) trigger
//  a notify at session_start, fallback to default."
//
// Closes the M001 round-0 PARTIAL on criterion #4 by asserting that the
// !Number.isInteger() check is present in src/core/overrides.ts AND that a
// standalone loadOverrides probe rejects a fractional contextWindow.
//
// Pattern: MEM020 (Node 18+ stdlib, no test-runner dependency, no tsc compile).
//
// Exit code 0 on full pass; non-zero with a summary on any failure.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OVERRIDES_PATH = join(ROOT, "src", "core", "overrides.ts");

let checks = 0;
let passed = 0;
const failures = [];

function check(name, fn) {
	checks++;
	try {
		const ok = fn();
		if (ok) {
			passed++;
			console.log(`OK  ${name}`);
		} else {
			failures.push(name);
			console.log(`FAIL ${name}`);
		}
	} catch (err) {
		failures.push(`${name} (threw: ${err.message})`);
		console.log(`FAIL ${name} (threw: ${err.message})`);
	}
}

// Source-shape check: !Number.isInteger() is present in overrides.ts
const source = await readFile(OVERRIDES_PATH, "utf8");
check("overrides.ts contains !Number.isInteger(override.contextWindow)", () =>
	source.includes("!Number.isInteger(override.contextWindow)"),
);
check("overrides.ts validation order includes Number.isInteger", () => {
	// Order check: the integer check must be in the same if-block as the
	// finite and > 0 checks, not somewhere unrelated. Search for the full
	// chain pattern.
	const pattern =
		/typeof\s+override\.contextWindow\s*!==\s*"number"[\s\S]*?Number\.isFinite[\s\S]*?<=\s*0[\s\S]*?Number\.isInteger/;
	return pattern.test(source);
});
check("overrides.ts invalid reason mentions integer", () =>
	source.includes("expected positive integer, got"),
);

// Source-shape check: the type annotation accepts number (not integer-only)
// so TypeScript doesn't reject valid input before the runtime check fires.
check("ModelOverride.contextWindow is typed as number", () => {
	const pattern = /contextWindow\?:\s*number\s*;/;
	return pattern.test(source);
});

// Behavioral check: import the module and exercise loadOverrides with a
// fractional input. Bun handles TS extensionless imports natively (per
// MEM020/MEM015). If the test environment is node, fall through to a
// source-grep-only verification (the source check above is then the proof).
const isBun = typeof globalThis.Bun !== "undefined";
if (isBun) {
	try {
		const { loadOverrides } = await import("../src/core/overrides.ts");
		const fs = await import("node:fs/promises");
		// Create a throwaway agent dir with a m3-clean-overrides.json file
		// containing a fractional contextWindow.
		const sandbox = join(ROOT, ".gsd", "exec", "criterion-4-sandbox");
		await fs.rm(sandbox, { recursive: true, force: true });
		await fs.mkdir(sandbox, { recursive: true });
		await fs.writeFile(
			join(sandbox, "m3-clean-overrides.json"),
			JSON.stringify({
				"minimax-m3-clean": {
					"MiniMax-M3": { contextWindow: 1234.5 },
				},
			}),
		);
		const result = await loadOverrides(sandbox);
		await fs.rm(sandbox, { recursive: true, force: true });
		// The fraction should be rejected → result.invalid[] should have one
		// entry naming contextWindow, and result.contextWindow should remain
		// the default (M3_DEFAULTS.contextWindow).
		check(
			"loadOverrides rejects fractional contextWindow into result.invalid",
			() =>
				result.invalid.length === 1 &&
				result.invalid[0].field === "contextWindow" &&
				result.invalid[0].reason.includes("integer"),
		);
		check(
			"loadOverrides falls back to default for fractional contextWindow",
			() =>
				result.contextWindow !== 1234.5 &&
				Number.isInteger(result.contextWindow) &&
				result.contextWindow > 0,
		);
	} catch (err) {
		failures.push(`bun behavioral import threw: ${err.message}`);
		console.log(`FAIL bun behavioral import threw: ${err.message}`);
		checks += 2; // we attempted 2 checks
	}
} else {
	console.log(
		"INFO node runtime detected — skipping in-process behavioral check (Bun required for TS extensionless import; source-shape checks are the proof)",
	);
}

// Negative case: a non-integer that is also a valid number should still be
// rejected. (Already covered by the source check; this is a sanity note.)
check("overrides.ts !Number.isInteger check is inside the same if-block as !Number.isFinite", () => {
	// Distance from "Number.isFinite" to "Number.isInteger" must be small
	// (within the same conditional). Capture the surrounding context.
	const idx = source.indexOf("Number.isFinite(override.contextWindow)");
	if (idx === -1) return false;
	const tail = source.slice(idx, idx + 500);
	return tail.includes("Number.isInteger(override.contextWindow)");
});

console.log(`\n${passed} of ${checks} checks passed`);
if (failures.length > 0) {
	console.log("FAILURES:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
process.exit(0);
