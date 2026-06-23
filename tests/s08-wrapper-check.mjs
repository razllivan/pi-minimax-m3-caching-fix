#!/usr/bin/env node
// Regression check for S08: wrapper-level compat pass-through. Verifies
// that the runtime half of MEM017 (MEM024 / MEM025) — the explicit
// `compat: M3_COMPAT` in the `streamSimple` bridge spread — is still
// present in `index.ts`, that the file header docstring references the
// MEM ids and the S05 evidence record, and that the CHANGELOG Unreleased
// Fixed section carries the same MEM ids and evidence record. Exits 0
// only when all checks pass. Node 18+ stdlib only, no test-runner
// dependency. Mirrors tests/s04-scripts-check.mjs and
// tests/s05-m3compat-check.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const indexPath = resolve(repoRoot, "index.ts");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

const indexSrc = readFileSync(indexPath, "utf8");
const changelogSrc = readFileSync(changelogPath, "utf8");

// --- (a) index.ts wrapper spread includes `compat: M3_COMPAT` ---
// Anchor on the streamSimpleFn invocation so a future rename of the
// variable is loud. Matches a line that spreads `compat: M3_COMPAT`
// alongside `api: "openai-completions"` inside the wrapper.
const wrapperSpreadRegex =
	/streamSimpleFn\(\s*\{\s*\.\.\.model\s*,\s*api\s*:\s*"openai-completions"\s*,\s*compat\s*:\s*M3_COMPAT\s*\}/;
const wrapperSpreadOk = wrapperSpreadRegex.test(indexSrc);

// --- (b) index.ts docstring contains MEM024 or MEM025 AND 745198ad ---
// MEM024 and MEM025 are the S05 record ids that document why the
// wrapper-level compat assignment is structural, not cosmetic. The
// evidence record `745198ad` is the S05 T01 commit hash that closes
// the source half. We require both: a MEM reference AND the evidence
// record, because either alone is too easy to lose in a future refactor.
const docstringHasMem = /\bMEM024\b/.test(indexSrc) || /\bMEM025\b/.test(indexSrc);
const docstringHasEvidence = /\b745198ad\b/.test(indexSrc);

// --- (c) CHANGELOG Unreleased Fixed section contains MEM024 or MEM025
// AND 745198ad ---
// We restrict the search to the Unreleased block when one exists with
// content, so a future "Fixed" entry under a released version that
// reuses the MEM ids does not accidentally satisfy the assertion. The
// block runs from `## [Unreleased]` to the next `## [` heading (or
// EOF). When `[Unreleased]` is empty (the state after a release moves
// its content to a dated heading — see T04 of M004/S01), fall back to
// searching across all `### Fixed` sections in CHANGELOG.md: the
// load-bearing intent is that the MEM ids and evidence record remain
// documented somewhere in CHANGELOG so a future refactor that loses
// them is loud. MEM024/MEM025/745198ad are S05 historical refs and
// landed in [0.2.1] when that release shipped the source half.
const unreleasedStart = changelogSrc.indexOf("## [Unreleased]");
const nextHeadingMatch = changelogSrc
	.slice(unreleasedStart + 1)
	.match(/\n## \[/);
const unreleasedEnd =
	nextHeadingMatch && typeof nextHeadingMatch.index === "number"
		? unreleasedStart + 1 + nextHeadingMatch.index
		: changelogSrc.length;
const unreleasedBlock =
	unreleasedStart >= 0 ? changelogSrc.slice(unreleasedStart, unreleasedEnd) : "";
// `### Fixed` sections inside [Unreleased] (if any).
const unreleasedFixedSections =
	unreleasedBlock.match(/### Fixed[\s\S]*?(?=\n### |\n## |\n*$)/g) ?? [];
const unreleasedFixedBlock = unreleasedFixedSections.join("\n");

// `### Fixed` sections across the entire CHANGELOG (for fallback when
// [Unreleased] is empty post-release).
const allFixedSections =
	changelogSrc.match(/### Fixed[\s\S]*?(?=\n### |\n## |\n*$)/g) ?? [];
const allFixedBlock = allFixedSections.join("\n");

const changelogUnreleasedHasContent = unreleasedBlock
	.replace(/^## \[Unreleased\][\s\S]*?\n/, "")
	.trim().length > 0;
const changelogHasMem = changelogUnreleasedHasContent
	? (/\bMEM024\b/.test(unreleasedFixedBlock) || /\bMEM025\b/.test(unreleasedFixedBlock))
	: (/\bMEM024\b/.test(allFixedBlock) || /\bMEM025\b/.test(allFixedBlock));
const changelogHasEvidence = changelogUnreleasedHasContent
	? /\b745198ad\b/.test(unreleasedFixedBlock)
	: /\b745198ad\b/.test(allFixedBlock);

const checks = [
	{
		name: "index.ts: streamSimple wrapper spread includes `compat: M3_COMPAT`",
		ok: wrapperSpreadOk,
	},
	{
		name: "index.ts: file header references MEM024 or MEM025",
		ok: docstringHasMem,
	},
	{
		name: "index.ts: file header references evidence record 745198ad",
		ok: docstringHasEvidence,
	},
	{
		name: "CHANGELOG [Unreleased] / ### Fixed references MEM024 or MEM025",
		ok: changelogHasMem,
	},
	{
		name: "CHANGELOG [Unreleased] / ### Fixed references evidence record 745198ad",
		ok: changelogHasEvidence,
	},
	{
		name: "CHANGELOG [Unreleased] section is present",
		ok: unreleasedStart >= 0,
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
	`\nS08 wrapper-level compat pass-through regression check passed (6 of 6 checks).`,
);
process.exit(0);
