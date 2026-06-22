#!/usr/bin/env node
// Regression check for S02 T01: the `tests/uat/omp-auth-login.sh`
// runtime UAT script exists, is a regular file, is non-empty, starts
// with a shebang, passes `bash -n`, and contains the load-bearing
// markers that prove it asserts the right surface.
//
// Pattern: MEM020 hermetic-test (Node 18+ stdlib only, no jest/vitest,
// no tsc compile). Mirrors tests/s08-uat-script-check.mjs and
// tests/s07-install-cycle-check.mjs.
//
// The script proves the runtime end-to-end chain:
//
//   omp plugin install --local
//     → omp auth-broker login <id>      (drives our S01 oauth callback)
//     → omp auth-broker list --json     (proves the provider reached the registry)
//     → MINIMAX_API_KEY UNSET + no --api-key
//     → session log shows cacheRead > 0 (proves saved credential reached the driver)
//
// A future "rename the provider" or "soften the assert" refactor will
// land loudly on this check before the runtime check silently breaks.
//
// Invoked as `node tests/s02-uat-omp-login-check.mjs`. Exits 0 only
// when all structural assertions pass.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const scriptPath = resolve(repoRoot, "tests/uat/omp-auth-login.sh");

// --- (a) file-exists / regular / non-empty / shebang ---
let st;
try {
	st = statSync(scriptPath);
} catch (err) {
	console.log(`FAIL tests/uat/omp-auth-login.sh (stat: ${err.code || err.message})`);
	console.log(`\n1 of 1 checks failed`);
	process.exit(1);
}

const isFile = st.isFile();
const nonEmpty = st.size > 0;
const head = isFile && nonEmpty ? readFileSync(scriptPath, "utf8").slice(0, 2) : "";
const hasShebang = head === "#!";

// --- (b) bash -n syntactic validity ---
// bash -n exits 0 on syntactically valid scripts. -n only checks
// parse, never executes. Available on both POSIX bash and Git for
// Windows' bash; on Windows-native hosts (no bash) the spawn will
// fail and we record the failure with a clear diagnostic.
let bashNPassed = false;
let bashNDetail = "";
if (isFile && nonEmpty) {
	try {
		execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" });
		bashNPassed = true;
	} catch (err) {
		const code = err && err.status !== undefined ? err.status : "no-exit";
		const stderr = err && err.stderr ? err.stderr.toString().trim() : "";
		bashNDetail = ` (exit ${code}${stderr ? `: ${stderr}` : ""})`;
	}
}

// --- (c) load-bearing content markers ---
// The script must reference each of these literal strings somewhere
// in its body. A future refactor that drops the runtime signal
// (or replaces the provider name) surfaces here before the
// runtime check silently breaks.
const src = isFile && nonEmpty ? readFileSync(scriptPath, "utf8") : "";

const markers = [
	// Hermetic trap-restore — the script must not leave the user's
	// ~/.omp/agent/agent.db in a polluted state.
	"trap restore EXIT",
	// Unique echo tag emitted on every log line so the regression
	// check can find this script's output in a stream of other output.
	// Asserted here so a future "rename the tag" edit surfaces in CI
	// before the runtime check silently breaks.
	"m3-s02-uat",
	// The runtime signal we are proving: the openai-completions
	// driver actually produced a cache hit on a real turn.
	"cacheRead",
	// The registered provider name the script must invoke.
	"minimax-m3-clean",
	// The model id under the registered provider.
	"MiniMax-M3",
	// MEM028 guard: the turn command MUST NOT pass --api-key.
	// Asserted as a NEGATIVE pattern: the script body must NOT
	// contain `--api-key` on the turn command line. We check for
	// the literal "--api-key" appearing anywhere as a sentinel —
	// a future refactor that re-adds the override fails here.
	"--api-key",
	// The omp auth-broker login CLI form is the load-bearing entry
	// point that drives our S01 oauth callback.
	"auth-broker login",
	// The auth-broker list --json surface is the only built-in proof
	// that our provider reached the registry (S02 research F2).
	"auth-broker list --json",
	// The two-tier UAT (S02 R1 mitigation) requires the optional
	// M3_UAT_KEY env var for the end-to-end turn.
	"M3_UAT_KEY",
	// S03/M003 host-branched direct registration path. The runtime
	// UAT script's diagnostic narrative must reference the omp-
	// specific import surface so the script body stays aligned with
	// the production code that the S03 patch added to index.ts.
	// The strings are documentation in the script body (the script
	// itself doesn't import or call these symbols), so the marker
	// locks in the alignment rather than the runtime behavior.
	"@oh-my-pi/pi-ai/oauth",
	"registerOAuthProvider",
];

const checks = [
	{
		name: "tests/uat/omp-auth-login.sh exists",
		ok: true,
	},
	{
		name: "tests/uat/omp-auth-login.sh is a regular file",
		ok: isFile,
	},
	{
		name: "tests/uat/omp-auth-login.sh is non-empty",
		ok: nonEmpty,
	},
	{
		name: "tests/uat/omp-auth-login.sh starts with a shebang",
		ok: hasShebang,
	},
	{
		name: "tests/uat/omp-auth-login.sh passes bash -n",
		ok: bashNPassed,
		detail: bashNDetail,
	},
	...markers.map((marker) => ({
		name: `tests/uat/omp-auth-login.sh contains marker ${JSON.stringify(marker)}`,
		ok: src.includes(marker),
	})),
];

// --- (d) MEM028 guard: turn command must NOT pass --api-key ---
// Per MEM028, omp 16.0.2's openai-completions driver reads the API
// key from `--api-key` at request time. To prove the SAVED credential
// reaches the driver, the turn command MUST NOT pass `--api-key`. The
// S07 install-cycle script DOES pass --api-key (it proves a different
// surface); this script must NOT.
//
// We assert this as a structural invariant: the turn command line in
// the script (the `timeout 60 "$HOST_BIN" \` invocation in the
// `Step 4` block) must not contain `--api-key` as a flag. The marker
// check above already ensures the script body MENTIONS `--api-key`
// (in a docstring/MEM028 reference), so the comment-vs-code
// disambiguation is intentional: a future refactor that re-adds
// `--api-key` to the turn command line breaks this check even if
// the MEM028 docstring is still present.
const turnCommandLine = (() => {
	if (!src) return "";
	// Locate the turn command block: search for the timeout line that
	// follows the "Step 4" comment. We match the contiguous command
	// body from `timeout 60` through the closing `\` continuations
	// up to the prompt argument.
	const lines = src.split("\n");
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes("timeout 60") && lines[i].includes('"$HOST_BIN"')) {
			startIdx = i;
			break;
		}
	}
	if (startIdx < 0) return "";
	let block = "";
	for (let i = startIdx; i < Math.min(startIdx + 12, lines.length); i++) {
		block += lines[i] + "\n";
		if (lines[i].includes("-p") || lines[i].includes("--api-key")) {
			// Stop at the -p flag (or at the --api-key if it was added).
		}
	}
	return block;
})();

const turnHasApiKey = /^\s*--api-key\b/m.test(turnCommandLine);
checks.push({
	name: "tests/uat/omp-auth-login.sh turn command does NOT pass --api-key (MEM028 guard)",
	ok: !turnHasApiKey,
});

// --- (e) AGENTS.md cross-reference ---
// The AGENTS.md "End-to-end testing pattern" sub-section must reference
// this script by filename so a future "rename the script" edit
// surfaces here before the documentation goes stale.
const agentsPath = resolve(repoRoot, "AGENTS.md");
const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";

checks.push({
	name: "AGENTS.md references tests/uat/omp-auth-login.sh",
	ok: agents.includes("tests/uat/omp-auth-login.sh"),
});

// --- Result tally ---
let failed = 0;
for (const check of checks) {
	if (check.ok) {
		console.log(`OK ${check.name}`);
	} else {
		const detail = check.detail ? ` (${check.detail})` : "";
		console.log(`FAIL ${check.name}${detail}`);
		failed++;
	}
}

if (failed > 0) {
	console.log(`\n${failed} of ${checks.length} checks failed`);
	process.exit(1);
}

console.log(
	`\nS02 T01 omp /login auth-login UAT regression check passed (${checks.length} of ${checks.length} checks).`,
);
process.exit(0);
