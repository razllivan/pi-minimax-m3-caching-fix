#!/usr/bin/env node
// Regression check for S05: M3_COMPAT shape. Verifies that the
// `streamIdleTimeoutMs` field added to M3_COMPAT in T01 (closing MEM017)
// is still present and is a finite positive number. Exits 0 only when all
// checks pass.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const providersPath = resolve(repoRoot, "src/core/providers.ts");
const providers = readFileSync(providersPath, "utf8");

// Anchor on the literal field assignment line so a future rename is loud.
// Matches: `streamIdleTimeoutMs: <value>,` where <value> is digits/underscores
// and the line ends with a comma (matches the M3_COMPAT object body).
const fieldRegex = /streamIdleTimeoutMs\s*:\s*([0-9_]+)\s*,/;
const match = providers.match(fieldRegex);
const rawValue = match ? match[1] : null;
const numericValue = rawValue !== null ? Number(rawValue.replace(/_/g, "")) : null;

const checks = [
	{
		name: "M3_COMPAT.streamIdleTimeoutMs is present",
		ok: rawValue !== null,
	},
	{
		name: "M3_COMPAT.streamIdleTimeoutMs is a finite positive number",
		ok:
			typeof numericValue === "number" &&
			Number.isFinite(numericValue) &&
			numericValue > 0,
	},
];

let failed = 0;
for (const check of checks) {
	if (check.ok) {
		console.log(`OK ${check.name}`);
	} else {
		console.log(`FAIL ${check.name}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n${failed} of ${checks.length} checks failed`);
	process.exit(1);
}

console.log(
	`\nM3_COMPAT.streamIdleTimeoutMs = ${numericValue} (source: src/core/providers.ts)`,
);
process.exit(0);
