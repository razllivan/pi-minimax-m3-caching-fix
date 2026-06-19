#!/usr/bin/env node
// Regression check for S07: the three per-host install-cycle shell
// scripts exist, are syntactically valid (`bash -n`), and that AGENTS.md
// "End-to-end testing pattern" section references them. Extended by M002
// S11 to also lock in the three MEM027 bug fixes (provider name canonical,
// Windows cwd-prefix glob, omp install CLI form).
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
let totalChecks = 0;

function pass(name) {
	console.log(`OK ${name}`);
	totalChecks++;
}

function fail(name, detail = "") {
	console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
	totalChecks++;
	failed++;
}

// ─── Script existence + bash -n syntactic validity ────────────────────────

for (const name of SCRIPT_NAMES) {
	const p = resolve(tasksDir, name);
	if (!existsSync(p)) {
		fail(name, `does not exist at ${p}`);
		continue;
	}
	// bash -n exits 0 on syntactically valid scripts. -n only checks
	// parse, never executes. Available on both POSIX bash and Git for
	// Windows' bash; on Windows-native hosts (no bash) the spawn will
	// fail and we record the failure with a clear diagnostic.
	try {
		execFileSync("bash", ["-n", p], { stdio: "pipe" });
		pass(`${name} (exists, bash -n passes)`);
	} catch (err) {
		const code = err && err.status !== undefined ? err.status : "no-exit";
		const stderr = err && err.stderr ? err.stderr.toString().trim() : "";
		fail(name, `bash -n exited ${code}${stderr ? `: ${stderr}` : ""}`);
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
	pass(subSectionCheck.name);
} else {
	fail(subSectionCheck.name);
}

const referencesCheck = {
	name: "AGENTS.md references all three S07 install-cycle scripts",
	ok: SCRIPT_NAMES.every((name) => agents.includes(name)),
};

if (referencesCheck.ok) {
	pass(referencesCheck.name);
} else {
	fail(referencesCheck.name);
}

// ─── MEM027 bug regression checks (M002 S11) ───────────────────────────────
//
// Bug (1): the pi and gsd scripts passed the stale `minimax-m3-cache-fixed`
// provider name to the turn command. S04 finalized the canonical name as
// `minimax-m3-clean`. The fix is script-localized — both scripts must now
// use the canonical name.
//
// Bug (2): the session-log glob in each script only matched the bare
// SCRATCH_DIR basename. On Windows the embedded cwd prefix is the full
// `--C--Users-...--<basename>--` path. The fix widens the glob to probe
// the Windows-style prefix in addition to the basename and the macOS
// /private/ variant.
//
// Bug (3): the omp script invoked `omp install -l ./` and `omp remove -l ./`,
// but omp 16.0.2's CLI does NOT accept the `-l` short form. The fix uses
// `omp plugin install --local` and `omp plugin remove`.

for (const name of ["T01-pi-install-cycle.sh", "T01-gsd-install-cycle.sh"]) {
	const p = resolve(tasksDir, name);
	if (!existsSync(p)) continue; // existence check already reported
	const src = readFileSync(p, "utf8");
	// Bug (1) — provider name
	if (src.includes("--provider minimax-m3-clean")) {
		pass(`${name} uses canonical provider name minimax-m3-clean (MEM027 bug 1 fixed)`);
	} else {
		fail(`${name} does not use canonical provider name minimax-m3-clean (MEM027 bug 1)`);
	}
	if (src.includes("minimax-m3-cache-fixed")) {
		fail(`${name} still references stale provider name minimax-m3-cache-fixed (MEM027 bug 1 not fully removed)`);
	}
	// Bug (2) — Windows cwd-prefix glob
	if (src.includes("SCRATCH_BASENAME=")) {
		pass(`${name} uses SCRATCH_BASENAME variable for cwd-prefix glob (MEM027 bug 2 fixed)`);
	} else {
		fail(`${name} does not use SCRATCH_BASENAME variable (MEM027 bug 2 not fixed)`);
	}
	if (src.includes('sed \'s|/|--|g')) {
		pass(`${name} probes Windows-style cwd prefix in addition to basename (MEM027 bug 2)`);
	} else {
		fail(`${name} does not probe Windows-style cwd prefix (MEM027 bug 2)`);
	}
}

const ompPath = resolve(tasksDir, "T01-omp-install-cycle.sh");
if (existsSync(ompPath)) {
	const ompSrc = readFileSync(ompPath, "utf8");
	// omp script uses HOST_PROVIDER (already set to minimax-m3-clean
	// canonically per the S07 authoring). Bug (1) is structurally
	// absent for omp; we just verify HOST_PROVIDER is the canonical.
	if (ompSrc.includes('HOST_PROVIDER="minimax-m3-clean"')) {
		pass("T01-omp-install-cycle.sh uses canonical provider name (MEM027 bug 1)");
	} else {
		fail("T01-omp-install-cycle.sh does not pin HOST_PROVIDER to canonical name (MEM027 bug 1)");
	}
	// Bug (2) for omp
	if (ompSrc.includes("SCRATCH_BASENAME=")) {
		pass("T01-omp-install-cycle.sh uses SCRATCH_BASENAME variable (MEM027 bug 2 fixed)");
	} else {
		fail("T01-omp-install-cycle.sh does not use SCRATCH_BASENAME variable (MEM027 bug 2 not fixed)");
	}
	// Bug (3) — omp install CLI form
	if (ompSrc.includes("plugin install --local") || ompSrc.includes("plugin install -l ")) {
		pass("T01-omp-install-cycle.sh uses `omp plugin install --local` (MEM027 bug 3 fixed)");
	} else {
		fail("T01-omp-install-cycle.sh does not use omp-correct install CLI (MEM027 bug 3)");
	}
	if (ompSrc.includes("plugin remove")) {
		pass("T01-omp-install-cycle.sh uses `omp plugin remove` (MEM027 bug 3)");
	} else {
		fail("T01-omp-install-cycle.sh does not use omp plugin remove (MEM027 bug 3)");
	}
	// omp-specific: --session-id is rejected by omp's CLI (per MEM027)
	// and --provider is the legacy flag. We assert the omp script uses
	// the slash-form --model <provider>/<model>.
	if (ompSrc.includes('"${HOST_PROVIDER}/MiniMax-M3"')) {
		pass("T01-omp-install-cycle.sh uses --model <provider>/<model> slash form (MEM028)");
	} else {
		fail("T01-omp-install-cycle.sh does not use --model slash form (MEM028)");
	}
	if (!ompSrc.includes("--session-id \"$SESSION_ID\"")) {
		pass("T01-omp-install-cycle.sh does not use rejected --session-id (MEM027 bug 3)");
	} else {
		fail("T01-omp-install-cycle.sh still uses --session-id (rejected by omp CLI)");
	}
}

// ─── Result ────────────────────────────────────────────────────────────────

if (failed > 0) {
	console.error(`\n${failed} of ${totalChecks} checks failed`);
	process.exit(1);
}

console.log(`\nAll ${totalChecks} install-cycle regression checks passed`);
process.exit(0);
