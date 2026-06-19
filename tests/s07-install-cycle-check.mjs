#!/usr/bin/env node
// Regression check for S07: the three per-host install-cycle shell
// scripts exist, are syntactically valid (`bash -n`), and that AGENTS.md
// "End-to-end testing pattern" section references them.
//
// Pattern: MEM020 hermetic-test (Node 18+ stdlib only, no jest/vitest,
// no tsc compile). Mirrors tests/s04-scripts-check.mjs / s04-docs-check.mjs
// in style.
//
// Invoked as `node tests/s07-install-cycle-check.mjs`. Exits 0 only
// when all checks pass.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const tasksDir = resolve(
	repoRoot,
	".gsd/milestones/M001/slices/S07/tasks",
);

const agentsPath = resolve(repoRoot, "AGENTS.md");

const SCRIPT_NAMES = [
	"T01-pi-install-cycle.sh",
	"T01-gsd-install-cycle.sh",
	"T01-omp-install-cycle.sh",
];

const agents = readFileSync(agentsPath, "utf8");

let failed = 0;
const totalChecks = SCRIPT_NAMES.length + 2;

// ─── Script existence + bash -n syntactic validity ────────────────────────

for (const name of SCRIPT_NAMES) {
	const p = resolve(tasksDir, name);
	if (!existsSync(p)) {
		console.log(`FAIL ${name} (does not exist at ${p})`);
		failed++;
		continue;
	}
	// bash -n exits 0 on syntactically valid scripts. -n only checks
	// parse, never executes. Available on both POSIX bash and Git for
	// Windows' bash; on Windows-native hosts (no bash) the spawn will
	// fail and we record the failure with a clear diagnostic.
	try {
		execFileSync("bash", ["-n", p], { stdio: "pipe" });
		console.log(`OK ${name} (exists, bash -n passes)`);
	} catch (err) {
		const code = err && err.status !== undefined ? err.status : "no-exit";
		const stderr = err && err.stderr ? err.stderr.toString().trim() : "";
		console.log(
			`FAIL ${name} (bash -n exited ${code}${stderr ? `: ${stderr}` : ""})`,
		);
		failed++;
	}
}

// ─── AGENTS.md cross-references ───────────────────────────────────────────
//
// The "End-to-end testing pattern" section must contain a sub-section
// titled "Install cycle verification" that mentions the three scripts.
// We assert the section header is present and each script filename
// appears in the file at least once.

const subSectionCheck = {
	name: 'AGENTS.md "End-to-end testing pattern" section has sub-section "Install cycle verification"',
	ok:
		/## End-to-end testing pattern[\s\S]*?### Install cycle verification/.test(
			agents,
		),
};

if (subSectionCheck.ok) {
	console.log(`OK ${subSectionCheck.name}`);
} else {
	console.log(`FAIL ${subSectionCheck.name}`);
	failed++;
}

const referencesCheck = {
	name: "AGENTS.md references all three S07 install-cycle scripts",
	ok: SCRIPT_NAMES.every((name) => agents.includes(name)),
};

if (referencesCheck.ok) {
	console.log(`OK ${referencesCheck.name}`);
} else {
	console.log(`FAIL ${referencesCheck.name}`);
	failed++;
}

// ─── Result ────────────────────────────────────────────────────────────────

if (failed > 0) {
	console.error(`\n${failed} of ${totalChecks} checks failed`);
	process.exit(1);
}

console.log(`\nAll ${totalChecks} install-cycle regression checks passed`);
process.exit(0);
