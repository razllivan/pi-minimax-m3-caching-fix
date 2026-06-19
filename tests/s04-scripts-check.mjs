#!/usr/bin/env node
// Regression check for S04 task T04: the two reusable per-host UAT shell
// scripts exist, are non-empty, and are executable. Exits 0 only when all
// three checks pass for both scripts.
//
// Invoked as `node tests/s04-scripts-check.mjs`. Self-contained: Node 18+
// stdlib only (fs, path, url).

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const tasksDir = resolve(
	repoRoot,
	".gsd/milestones/M001/slices/S04/tasks",
);

const SCRIPT_NAMES = [
	"T04-uat-omp-happy.sh",
	"T04-uat-omp-invalid.sh",
];

let failed = 0;
for (const name of SCRIPT_NAMES) {
	const p = resolve(tasksDir, name);
	let st;
	try {
		st = statSync(p);
	} catch (err) {
		console.log(`FAIL ${name} (stat: ${err.code || err.message})`);
		failed++;
		continue;
	}
	if (!st.isFile()) {
		console.log(`FAIL ${name} (not a regular file)`);
		failed++;
		continue;
	}
	if (st.size === 0) {
		console.log(`FAIL ${name} (empty file)`);
		failed++;
		continue;
	}
	// mode & 0o111 nonzero means at least one execute bit is set (user, group, or other).
	// On POSIX (darwin/linux/freebsd) the mode bits carry execute semantics.
	// On Windows (win32) the underlying filesystem is NTFS, which does not
	// honor the Unix execute bit — every file is reported as 0o100666
	// (regular file, rw-rw-rw-) regardless of chmod. Node's `process.platform`
	// is the cheapest reliable signal; we still report the raw mode so a
	// future maintainer running on a POSIX host without +x sees a clear
	// diagnostic, but the assertion is relaxed to skip on win32.
	if (process.platform !== "win32" && (st.mode & 0o111) === 0) {
		console.log(`FAIL ${name} (not executable, mode=0o${st.mode.toString(8)})`);
		failed++;
		continue;
	}
	// Sanity: file starts with a shebang (POSIX shell convention for the .sh scripts
	// the slice plan calls for). Cheap to check; catches a copy-paste-with-wrong-ext.
	const head = readFileSync(p, "utf8").slice(0, 2);
	if (head !== "#!") {
		console.log(`FAIL ${name} (no shebang on first line: ${JSON.stringify(head)})`);
		failed++;
		continue;
	}
	console.log(`OK ${name}`);
}

if (failed > 0) {
	console.log(`FAIL scripts present and executable (${failed} failure${failed === 1 ? "" : "s"})`);
	process.exit(1);
}
console.log("OK scripts present and executable");
