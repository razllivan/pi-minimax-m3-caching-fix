#!/usr/bin/env node
// Regression check for S04 doc sync. Verifies that the AGENTS.md and
// CHANGELOG.md updates reflecting the closed S04 static-import gap are
// present and the stale references are gone. Exits 0 only when all four
// checks pass.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const agentsPath = resolve(repoRoot, "AGENTS.md");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

const agents = readFileSync(agentsPath, "utf8");
const changelog = readFileSync(changelogPath, "utf8");

const checks = [
	{
		name: "AGENTS.md has new subsection",
		ok: agents.includes("omp install path is now functional (S04)"),
	},
	{
		name: "AGENTS.md removed old S04 forward ref",
		ok: !/planned S04 slice/.test(agents),
	},
	{
		name: "AGENTS.md removed driver-missing bullet",
		ok: !/does not register the `openai-completions` driver/.test(agents),
	},
	{
		name: "CHANGELOG.md has new bullet",
		ok: changelog.includes("omp install path is now functional"),
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

process.exit(0);
