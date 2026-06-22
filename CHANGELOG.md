# Changelog

All notable changes to `@razllivan/pi-minimax-m3-caching-fix` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## Highlights (this fork)

`@razllivan/pi-minimax-m3-caching-fix` is a fork of
[`pi-minimax-m3-caching-fix@0.2.0`](https://www.npmjs.com/package/pi-minimax-m3-caching-fix)
with multi-host support and tunable context windows:

- **Three Pi-family hosts, one install.** Runs on vanilla pi
  (`@earendil-works/pi-coding-agent@0.79.1`), the
  [`gsd-pi`](https://github.com/open-gsd/gsd-pi) fork, and
  [`Oh my Pi`](https://www.npmjs.com/search?q=%40oh-my-pi%2Fpi-coding-agent)
  (`@oh-my-pi/pi-coding-agent@16.0.2`). Pick the model with
  `(clean)` in the name in `/model` and the same provider name works
  on all three hosts. Empirical end-to-end evidence: a real omp
  streaming turn with `cacheRead: 34751` and `stopReason: stop`.
- **Tune the context window per host.** Drop a
  `m3-clean-overrides.json` file in the active agent directory
  (`~/.pi/agent/`, `~/.gsd/agent/`, or `~/.omp/agent/`) and the
  registered `MiniMax-M3` model picks up your `contextWindow` on
  startup. Invalid values (non-positive, non-numeric, non-integer)
  are reported via a TUI notification at `session_start` and the
  field falls back to the built-in 1M default. The file is read
  from the host-correct agent dir — no env vars to set, no
  cross-contamination on a multi-host dev machine.
- **Fail-soft provider registration.** Missing drivers and
  `registerProvider` validation throws no longer crash the
  session; they surface as a single session_start TUI warning and
  the affected provider is skipped. Safe to install on hosts
  that don't have `openai-completions` registered.
- **Per-host install-cycle verification.** Three bash scripts
  (`T01-{pi,gsd,omp}-install-cycle.sh`) snapshot the host's
  session log dir, run install → single-turn → remove, and assert
  the new `.jsonl` session log appears at the host-correct path.
  Self-contained `.mjs` regression checks (`tests/s07-install-cycle-check.mjs`)
  lock the canonical provider name, the omp CLI form, the Windows
  cwd-prefix glob, and the omp slash-form turn command.

## [Unreleased]

## [0.2.3] - 2026-06-22

Adds the omp `/login` auth surface for custom providers and the
companion host-branched `registerOAuthProvider` safety-net dispatch.
Source-level additive change — the registered providers, the
in-flight thinking-cleanup wrapper, and all 0.2.x behavior are
preserved. Existing consumers on vanilla pi and gsd-pi are unaffected.

### Fixed

- **omp `/login` auth-broker contract gap (D-001 / MEM035).** Added a
  host-branched direct call to `registerOAuthProvider` from
  `@oh-my-pi/pi-ai/oauth` (loaded via dynamic `import()` inside an
  `if (host === "omp")` branch, per MEM037) so omp's auth-broker
  registry receives the OAuth descriptor for `minimax-m3-clean` and
  `minimax-cn-m3-clean` even when the upstream
  `validateProviderConfiguration` rejects the registration shape and
  the `pi.registerProvider({oauth})` path is short-circuited. The
  host branch is gated on `detectHost()` from `index.ts` (the same
  chain that `resolveAgentDir()` uses per MEM018), so vanilla pi and
  gsd paths are unchanged — the dynamic import lives entirely inside
  the omp branch and the other two hosts never load
  `@oh-my-pi/pi-ai/oauth`. `M3_COMPAT.streamIdleTimeoutMs: 30_000`
  (MEM017) is preserved. The cross-host regression orchestrator
  (`tests/uat/cross-host-regression.sh`) now treats the prior
  `EXPECTED_GAP` for D-001 and the install-cycle session-log-absent
  signature as hard failures, so a developer machine without
  `M3_UAT_KEY` reports **10 PASS, 0 EXPECTED_GAP, 0 FAIL** (up from
  the previous 9 PASS + 1 EXPECTED_GAP). Two structural regression
  checks are extended to lock the new path:
  `tests/s01-auth-surface.mjs` now has **21 assertions** (was 18)
  including the dual-registration markers, and
  `tests/s02-uat-omp-login-check.mjs` has **18 assertions** (was 16)
  including the `registerOAuthProvider` and host-branch markers.
  `bash tests/uat/omp-auth-login.sh` now exits 0 on omp 16.0.2 with
  no key required for the registration-shape proof. See
  `.gsd/milestones/M003/slices/S03/S03-SUMMARY.md` for the canonical
  walkthrough and `AGENTS.md` "omp `/login` auth surface for custom
  providers" for the host-branched dispatch contract.

### Added

- **omp `/login` auth surface for custom providers.** The extension's
  `registerProvider` call now includes an `oauth` block
  (`{ name, login, refreshToken, getApiKey }`) on every host so omp
  16.0.2 surfaces `minimax-m3-clean` and `minimax-cn-m3-clean` in its
  native `/login` provider picker. omp is the only host that reads
  this block — vanilla pi (`@earendil-works/pi-coding-agent@0.79.1`)
  and gsd-pi present their own built-in API-key dialog when you pick
  a provider from `/model`, and that dialog is what you'll use on
  those hosts. The same `oauth` block is registered on every host for
  shape uniformity; on pi/gsd it is a no-op. Users on omp can now
  persist their key once via `/login` → pick provider → paste key,
  and every subsequent `omp` turn uses the saved credential without
  needing `MINIMAX_API_KEY` exported in the shell. The env-var path
  (`export MINIMAX_API_KEY=...`) is retained as the primary path for
  scripted use on every host (CI, cron, Docker, systemd). See
  `README.md` "Saving your API key" and `AGENTS.md` "omp `/login`
  auth surface for custom providers" for the full walkthrough and
  the cross-host contract. A new runtime UAT
  (`tests/uat/omp-auth-login.sh`) drives `omp auth-broker login
  minimax-m3-clean` end-to-end and a 16-check hermetic regression
  (`tests/s02-uat-omp-login-check.mjs`) locks the structural
  invariants of that script.

## [0.2.2] - 2026-06-19

Patch release — documentation and metadata only. No source changes;
the extension behaves identically to 0.2.1 at runtime.

### Fixed

- **gsd-pi GitHub link in `CHANGELOG.md` and `README.md`.** The
  previous link `github.com/opengsd/gsd-pi` resolves to HTTP 404 on
  GitHub; the live repo is at `github.com/open-gsd/gsd-pi` (hyphen
  between `open` and `gsd`, matching the homepage field in the
  `@opengsd/gsd-pi` npm registry). The npm package name and scope
  (`@opengsd/gsd-pi`) are unchanged — only the GitHub URL was wrong.

### Changed

- **README `Features` section added.** New section between the
  Provider/Env-var table and Quickstart. Two bullets: 'Works on
  three Pi-family hosts' (enumerates vanilla pi, gsd-pi, Oh my Pi
  with package names and version pins, with the corrected
  `github.com/open-gsd/gsd-pi` link) and 'Tunable `contextWindow`'
  (short summary with anchor link to the detailed 'Tuning context
  window' section).
- **CHANGELOG header now references the scoped package name.**
  'All notable changes to `pi-minimax-m3-caching-fix`' ->
  '`@razllivan/pi-minimax-m3-caching-fix`'. The body still cites
  upstream 0.2.0 under the unscoped name on purpose (it is the
  upstream version this fork was branched from, not a name we
  own).
- **README install/remove commands updated to scoped package name.**
  `pi install npm:pi-minimax-m3-caching-fix` ->
  `pi install npm:@razllivan/pi-minimax-m3-caching-fix` (3
  occurrences: 'From npm' section, Quickstart, 'Removing the
  extension' section). Git-install examples in 'From a git
  checkout' and the pinned `@v0.2.1` example updated to match
  the latest release tag. Local-clone path
  `pi install ./pi-minimax-m3-caching-fix` left unchanged (the
  directory name is independent of the npm package name).

## [0.2.1] - 2026-06-19

Fork of upstream `pi-minimax-m3-caching-fix@0.2.0`. All Unreleased
changes from the in-flight-rewrite lineage are released as 0.2.1.
Diff against upstream 0.2.0: this fork adds multi-host support,
tunable `contextWindow`, fail-soft registration, and a host-aware
agent-dir resolver; the in-flight thinking-cleanup wrapper, the two
provider registrations, and the npm/git install paths are unchanged
from upstream 0.2.0.

### Fixed

- **Wrapper-level `compat: M3_COMPAT` pass-through in `streamSimple`
  bridge (MEM017 runtime half — MEM024 / MEM025).** The
  `makeProvider` wrapper in `index.ts` now spreads
  `compat: M3_COMPAT` into the object passed to the top-level
  `streamSimple` bridge, so omp's openai-completions driver actually
  receives `model.compat.streamIdleTimeoutMs: 30_000` at runtime.
  Without this, `buildCompat` writes `compat: undefined` and omp
  crashes on the first packet with "undefined is not an object
  (evaluating 'model.compat.streamIdleTimeoutMs')". This is the
  runtime half of MEM017; the source half — adding
  `streamIdleTimeoutMs: 30_000` to `M3_COMPAT` itself — shipped in the
  previous Unreleased entry. S04 T04 evidence record `150700a3`, S05
  T01 evidence record `745198ad`. After this: the registered
  `minimax-m3-clean / MiniMax-M3` provider streams a real turn on omp
  with `cacheRead` metrics, no fallback to the built-in
  `minimax-code / MiniMax-M3` needed.

### Fixed

- **Added `streamIdleTimeoutMs: 30_000` to `M3_COMPAT` (MEM017).** omp
  16.0.2's openai-completions driver enforces
  `model.compat.streamIdleTimeoutMs` and previously errored with
  "undefined is not an object" on the first request when the field was
  missing (S04 T04 evidence record 150700a3). Vanilla
  `@earendil-works/pi-ai@0.79.1` ignores the field, so this is a safe
  additive change for vanilla pi users. Replaces the S04 T04 fallback
  to the built-in `minimax-code/MiniMax-M3` provider on omp: the
  registered `minimax-m3-clean` provider now streams a real turn on omp
  with `cacheRead` metrics, no fallback needed.

### Changed

- **Modularized core logic.** The 640-line `index.ts` is split into four
  files: `index.ts` (orchestrator — agent-dir discovery, `makeProvider`,
  default-export factory), `src/core/providers.ts` (pure-constant provider
  metadata: `M3_COMPAT`, `M3_DEFAULTS`, `PROVIDERS`, `ProviderSpec`),
  `src/core/overrides.ts` (`m3-clean-overrides.json` parser and types),
  and `src/core/clean-stream.ts` (`ThinkScanner` and the `cleanStream`
  stream wrapper). No behavior change — the registered providers, the
  stream wrapper semantics, and the override-file format are identical.
  `package.json` `files` whitelist now includes `src/**/*.ts` so the new
  files ship in the published tarball.
- **omp install path is now functional.** Replaced
  `getApiProvider("openai-completions").streamSimple` with the
  top-level `streamSimple<TApi>(model, ctx, opts)` function (exists on
  vanilla `@earendil-works/pi-ai@0.79.1`, gsd-pi's `@gsd/pi-ai`
  symlink, and omp's `@oh-my-pi/pi-ai@16.0.2`). Replaced
  `createAssistantMessageEventStream()` factory call with
  `new AssistantMessageEventStream()` (same cross-host coverage).
  Dropped the defensive 'openai-completions driver not registered'
  warning path. Both the omp `models` listing and a real omp
  streaming turn now exercise the extension end-to-end.

### Added

- **Tunable `contextWindow` via `m3-clean-overrides.json`.** The extension
  reads `<agent-dir>/m3-clean-overrides.json` on startup and applies the
  `contextWindow` value to the registered `MiniMax-M3` model. The agent
  directory is discovered dynamically by importing `getAgentDir()` from
  the active Pi fork (`@earendil-works/pi-coding-agent`,
  `@oh-my-pi/pi-coding-agent`, or `@gsd/pi-coding-agent`), with a silent
  fallback to built-in defaults when none is installed. Other model
  fields (`cost`, `compat`, `headers`, `name`, etc.) remain at their
  built-in values; full overrides continue to go through `models.json`.
  Invalid `contextWindow` values (non-positive or non-numeric) are
  reported via a TUI notification at `session_start` and the field falls
  back to the default.
- **Multi-host peer pins for `omp`.** `package.json` declares
  `peerDependencies` and `devDependencies` for
  `@oh-my-pi/pi-coding-agent@16.0.2` and `@oh-my-pi/pi-ai@16.0.2`
  alongside the existing vanilla-pi pins. Both pins are surfaced to
  consumers as a `peerDependencies` warning on install when the user's
  installed version differs — the warning is the intended signal, not
  a configuration mistake. The full per-host contract is documented in
  `AGENTS.md` under "Multi-host support".
- **Runtime compatibility with `gsd-pi`.** The extension is also
  supported on the gsd fork (shipped as `gsd-pi` on npm). It is not
  pinned in `package.json` because its internal package name
  (`@gsd/pi-coding-agent`) is not published to the npm registry —
  `npm view @gsd/pi-coding-agent` returns 404. gsd-pi's loader injects
  `@gsd/pi-coding-agent` into the module path at runtime, so the
  extension's existing `resolveAgentDir` fallback chain still finds a
  match on a host running gsd-pi. This is documented as a known-
  compatible fork in `AGENTS.md`; declaring it in `package.json` is
  impossible (a peer pin would fail `pnpm install` with 404).
- **Fail-soft provider registration.** `index.ts` resolves the
  `openai-completions` driver once at extension load and wraps every
  `pi.registerProvider` call in a try/catch. A missing driver
  (`getApiProvider("openai-completions")` returns `undefined`) and a
  `registerProvider` validation throw both record a TUI warning that
  surfaces at `session_start` and skip the affected provider(s)
  instead of letting the exception propagate and crash the session.

## [0.2.0] - 2026-06-12

### Changed

- **Reworked cleanup from post-hoc to in-flight.** The previous version
  used a `message_end` hook to strip `<think>…</think>` markers and drop
  thinking blocks after the full turn had already streamed through the
  TUI. The new version wraps the built-in `openai-completions`
  `streamSimple` driver and rewrites the event stream in real time:
  duplicated thinking from M3's `reasoning_content` / `reasoning`
  alternation is suppressed, `<think>…</think>` spans are filtered out
  of text deltas (and their inner content routed to a real thinking
  block when no reasoning fields are streamed), and `text_start` is
  deferred until the first non-whitespace character.
- **Renamed providers** from `minimax-m3-cache-fixed` and
  `minimax-cn-m3-cache-fixed` to `minimax-m3-clean` and
  `minimax-cn-m3-clean`. Model display suffix changed from
  `(cache-fixed)` to `(clean)`. The wrapped provider is registered under
  a custom `api` id (the provider name) so only these models route
  through the wrapper.
- `index.ts` file header rewritten to describe the in-flight strategy
  and the two streaming quirks (duplicate reasoning, inline `<think>`)
  that motivate it.

### Added

- `package.json` `files` whitelist and `.npmignore` so `npm publish` ships
  only `index.ts`, `README.md`, `LICENSE`, `CHANGELOG.md`.
- `prepublishOnly` quality gate that runs `npm run check` (tsc) before
  every publish.
- `repository`, `homepage`, `bugs`, and explicit `author` fields.
- README documents the `pi install npm:pi-minimax-m3-caching-fix` flow
  alongside the existing git install.
- `peerDependencies` on `@earendil-works/pi-coding-agent@0.79.1` and
  `@earendil-works/pi-ai@0.79.1` to document the runtime contract.
- `devDependencies` on the same two packages so `npm run check` (and
  `prepublishOnly`) can resolve types without ad-hoc symlinks.
- `packageManager: pnpm@10.33.0` and a committed `pnpm-lock.yaml`.
  npm's installer hits malformed symlink entries in the
  `pi-coding-agent` tarball and leaves the project unable to resolve
  the type imports; pnpm installs cleanly. Publish target stays npm
  (that's what `pi install` resolves by default).

### Removed

- `PLAN.md`, `PLAN-DELTA.md`, and `TODO.md` from the repo. The reasoning
  they captured is summarized inline in `index.ts` and `AGENTS.md`.
- `AGENTS.md` and `index.ts` references to the deleted plan files.
- The `message_end` thinking-strip hook (subsumed by the in-flight
  stream wrapper).

## [0.1.0] - 2026-06-10

### Added

- Initial release. Registers two providers (`minimax-m3-cache-fixed`,
  `minimax-cn-m3-cache-fixed`) exposing `MiniMax-M3` on the OpenAI-compatible
  endpoint so passive prompt caching works.
- `message_end` hook that strips duplicated thinking output (the
  `<think>…</think>` markers M3 sends alongside the proper thinking block)
  for messages from the two registered providers.
- Reuses the existing `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` env vars — no
  new credentials needed.
- Mirrors the upstream fix from
  [`pi-mono@b85b91c9`](https://github.com/badlogic/pi-mono/commit/b85b91c9)
  for pi versions that don't yet include it.

### Known Limitations

- The thinking-strip happens at end-of-stream, so the duplicated thinking is
  briefly visible during streaming before the hook replaces the final
  message. The saved session log is clean.
- Two `MiniMax-M3` entries appear in `/model` (built-in broken + extension
  fixed). Users must pick the one with `(cache-fixed)` in the name.
