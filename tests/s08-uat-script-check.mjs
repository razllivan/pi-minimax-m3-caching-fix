#!/usr/bin/env node
// Regression check for S08 task T02: the T02-uat-omp-stream.sh
// UAT script exists, is a regular file, is non-empty, starts with a
// shebang, and contains the load-bearing markers that prove it
// asserts the right surface (registered provider, no MEM017 error,
// cacheRead > 0, hermetic trap-restore).
//
// Invoked as `node tests/s08-uat-script-check.mjs`. Self-contained:
// Node 18+ stdlib only (fs, path, url). Mirrors the pattern of
// tests/s04-scripts-check.mjs and tests/s08-wrapper-check.mjs.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const tasksDir = resolve(
	repoRoot,
	".gsd/milestones/M001/slices/S08/tasks",
);
const scriptPath = resolve(tasksDir, "T02-uat-omp-stream.sh");

// --- (a) file-exists / regular / non-empty / shebang ---
let st;
try {
	st = statSync(scriptPath);
} catch (err) {
	console.log(`FAIL T02-uat-omp-stream.sh (stat: ${err.code || err.message})`);
	console.log(`\n1 of 1 checks failed`);
	process.exit(1);
}

const isFile = st.isFile();
const nonEmpty = st.size > 0;
const head = isFile && nonEmpty ? readFileSync(scriptPath, "utf8").slice(0, 2) : "";
const hasShebang = head === "#!";

// --- (b) load-bearing content markers ---
// The script must reference each of these literal strings somewhere
// in its body. A future "rename the provider" or "soften the assert"
// refactor will land loudly on this check before the runtime fix
// is lost.
const src = isFile && nonEmpty ? readFileSync(scriptPath, "utf8") : "";

const markers = [
	// Hermetic trap-restore — the script must not leave the user's
	// ~/.omp/agent directory in a modified state.
	"trap restore EXIT",
	// Unique echo tag emitted on every log line, so the regression
	// check can find this script's output in a stream of other
	// output. Asserted here so a future "rename the tag" edit
	// surfaces in CI before the runtime check silently breaks.
	"m3-s08-t02",
	// The runtime signal we are proving: the openai-completions
	// driver actually produced a cache hit on a real turn.
	"cacheRead",
	// The literal MEM017 error string we are asserting is absent in
	// stderr. If a future refactor drops the assertion, the check
	// will land here first.
	"model.compat.streamIdleTimeoutMs",
	// The registered provider name the script must invoke.
	"minimax-m3-clean",
	// The model id under the registered provider.
	"MiniMax-M3",
];

const checks = [
	{
		name: "T02-uat-omp-stream.sh exists",
		ok: true,
	},
	{
		name: "T02-uat-omp-stream.sh is a regular file",
		ok: isFile,
	},
	{
		name: "T02-uat-omp-stream.sh is non-empty",
		ok: nonEmpty,
	},
	{
		name: "T02-uat-omp-stream.sh starts with a shebang",
		ok: hasShebang,
	},
	...markers.map((marker) => ({
		name: `T02-uat-omp-stream.sh contains marker ${JSON.stringify(marker)}`,
		ok: src.includes(marker),
	})),
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
	console.log(`\n${failed} of ${checks.length} checks failed`);
	process.exit(1);
}

console.log(
	`\nS08 T02 UAT script regression check passed (${checks.length} of ${checks.length} checks).`,
);
process.exit(0);
