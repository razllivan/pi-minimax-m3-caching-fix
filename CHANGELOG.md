# Changelog

All notable changes to `pi-minimax-m3-caching-fix` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
