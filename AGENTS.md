# AGENTS.md

## What this is

Standalone pi extension that fixes MiniMax-M3 (built-in `minimax` provider in pi) by routing to `/v1/chat/completions` (passive cache) and stripping duplicated thinking via a `message_end` hook. Model display name suffix is `(cache-fixed)`. See `README.md`.

## Typecheck

```bash
pnpm install --ignore-scripts
pnpm run check
```

Use pnpm — not npm — for the local install. npm fails to fully extract
`@earendil-works/pi-coding-agent`'s tarball (the
`@mistralai/mistralai/src` and `.../esm` symlink tar entries trip npm's
extractor, and npm's flat hoisting leaves the package importable but
untyped from the project's `node_modules/`). pnpm's content-addressable
store and symlink-based layout install cleanly and `tsc` resolves the
types. `pnpm-lock.yaml` is committed; `package.json` pins pnpm via
`"packageManager": "pnpm@10.33.0"` so `corepack` picks the right
version.

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are
declared in `devDependencies` (pinned to `0.79.1`). `tsconfig.json`
enables `--skipLibCheck` and `--moduleResolution bundler` so transitive
type packages don't fail the check.

## Publish

```bash
pnpm install --ignore-scripts
npm publish --access public
```

Publish to the **npm** registry (`pi install npm:pi-minimax-m3-caching-fix`),
not pnpm's. The local install is pnpm for reproducible typecheck; the
distribution is npm because that's what `pi install` resolves by
default. `prepublishOnly` runs `npm run check` only — the maintainer's
local `node_modules/` is already populated by `pnpm install`, and `tsc`
is what we actually want to gate on.

## Install locally for testing

```bash
pi install -l ./
# ... do stuff ...
pi remove -l ./
```

Local install is reversible; doesn't pollute the user's global package list.

## End-to-end testing pattern

```bash
mkdir -p /tmp/pi-m3-test && cd /tmp/pi-m3-test
pi install -l /Users/wese/Repos/github.com/rwese/pi-minimax-m3-caching-fix
pi --provider minimax-m3-cache-fixed --model MiniMax-M3 --session-id my-test-1 -p "We are testing prompt caching. Acknowledge briefly."
pi --provider minimax-m3-cache-fixed --model MiniMax-M3 -c -p "What are we testing?"
# session log: /Users/wese/.pi/agent/sessions/--private-tmp-pi-m3-test--/*my-test-1*.jsonl
```

`--session-id` cannot be combined with `-c`; subsequent turns drop `--session-id` and use `-c` alone. The `~/.pi/agent/sessions/` paths use `private-` prefix for `/private/tmp/...` (macOS `/tmp` symlink target).

Inspecting the session log for cache hits:

```python
python3 -c "
import json
with open('PATH/TO/SESSION.jsonl') as f:
    for line in f:
        if not line.strip(): continue
        e = json.loads(line)
        if e.get('type') == 'message' and e.get('message', {}).get('role') == 'assistant':
            u = e['message'].get('usage', {})
            print(f'provider={e[\"message\"].get(\"provider\")} input={u.get(\"input\")} cacheRead={u.get(\"cacheRead\")}')
"
```

Healthy numbers: turn 1 `input ~ 9000, cacheRead ~ 100`. Turn 2+ `input ~ 100, cacheRead ~ 9000+`.

## Multi-host support

The extension targets three pi-family hosts. Each one discovers the
extension through its own loader and resolves `getAgentDir()` /
`getApiProvider` from its own bundled `@…/pi-coding-agent` and
`@…/pi-ai` packages. Per-host paths and peer pins are documented in
the subsections below; the runtime contract for each host is the
source of truth for the matching peer/dev pin in `package.json`.

### Override-file path per host

The active agent config directory is resolved dynamically by importing
`getAgentDir()` from whichever `@…/pi-coding-agent` package the host
exposes, with a silent fallback to defaults if none is installed. The
override file (`m3-clean-overrides.json`) lives in the per-host
agent dir:

| Pi fork        | Path                                   |
| -------------- | -------------------------------------- |
| vanilla pi     | `~/.pi/agent/m3-clean-overrides.json`  |
| omp            | `~/.omp/agent/m3-clean-overrides.json` |
| gsd            | `~/.gsd/agent/m3-clean-overrides.json` |

This mirrors the README's "Tuning context window" table — see that
section for the override-file schema and the "first valid
`contextWindow` wins" rule.

### Peer pin per host

`package.json` declares `peerDependencies` and `devDependencies` for
two of the three hosts. The peer pin is what surfaces a warning to
consumers on install when their installed version differs from the
pinned one — that warning is the intended signal; version drift is
loud rather than silent.

| Pi fork        | Peer pin                                                |
| -------------- | ------------------------------------------------------- |
| vanilla pi     | `@earendil-works/pi-{ai,coding-agent}@0.79.1`           |
| omp            | `@oh-my-pi/pi-{ai,coding-agent}@16.0.2`                 |
| gsd            | _runtime compatibility only — no peer pin (see below)_  |

### gsd has no peer pin on purpose

`gsd-pi` (the published npm package) ships the internal package name
`@gsd/pi-coding-agent`, which is **not** published to the npm
registry — `npm view @gsd/pi-coding-agent` returns 404. A
`peerDependencies` entry of `@gsd/pi-coding-agent` in our
`package.json` would therefore break `pnpm install` for the gsd
install path. gsd-pi's `dist/loader.js` prepends its own
`node_modules/` to `NODE_PATH` at runtime, which injects
`@gsd/pi-coding-agent` into the module resolution path; that is why
the extension's `resolveAgentDir` fallback chain still finds a match
on a host running gsd-pi (it falls through to `@gsd/pi-coding-agent`
when neither the vanilla nor the omp package is installed).
Documenting the runtime contract here and in `README.md` is the right
surface for gsd compatibility; declaring it in `package.json` is
impossible.

### omp has a known static-import gap (planned S04)

The current `index.ts` does a static
`import { getApiProvider } from "@earendil-works/pi-ai"`. omp's
`@oh-my-pi/pi-ai@16.0.2` does **not** export that symbol — it exposes
`getCustomApi` / `registerCustomApi` instead. T02's fail-soft only
catches the *runtime* case (the import succeeded but the driver is
not registered, or `registerProvider` throws). The static-import gap
is the planned S04 slice. Until S04 ships, the omp install path
works only if omp users also have `@earendil-works/pi-ai` resolvable
in their `node_modules/` (e.g. via a separate pi install on the
same machine). This is a known limitation, not a configuration
mistake.

### Fail-soft behavior (S02)

The orchestrator does not crash the whole session when this extension
loads on a host that:

- (a) does not register the `openai-completions` driver
  (`getApiProvider("openai-completions")` returns `undefined`); or
- (b) refuses to accept a provider name conflict in
  `pi.registerProvider(spec.name, ...)` (validation error throws).

Both cases record a TUI warning that surfaces at `session_start` and
skip the affected registration(s) — no exception propagates out of
the extension factory. Warnings are deferred to `session_start`
because `ctx.ui.notify` is not available in the extension factory —
the same precedent the override-file validation errors use.

## Critical learnings

### 1. The user's installed `pi-ai@0.79.1` does NOT have `compat.skipThinkingBlock`

The upstream fix `pi-mono@b85b91c9` adds it; the published npm version 0.79.1 predates that commit. **Do not** set `compat.skipThinkingBlock: true` in `registerProvider` — the field doesn't exist in the type, tsc will fail. Either:
- (chosen) strip thinking via a `message_end` hook at end-of-stream, or
- cast `compat` to bypass tsc and accept that the field is ignored at runtime

The original reasoning for the `message_end` approach (brief visual flash during streaming; session log stays clean) is summarized inline in `index.ts`'s file header.

### 2. `pi.registerProvider(name, { models })` REPLACES all models for that provider

Overriding the built-in `minimax` provider would wipe M2.x. Use distinct names (`minimax-m3-cache-fixed`, `minimax-cn-m3-cache-fixed`) and document in README that two `MiniMax-M3` entries appear in `/model` — pick the one with `(cache-fixed)` in the name.

### 3. Provider registration requires the env var to be set for the provider to appear

`ModelRegistry.hasConfiguredAuth()` checks `isConfigValueConfigured(providerApiKey)`. If the env var referenced by `$MINIMAX_CN_API_KEY` is unset, the `minimax-cn-m3-cache-fixed` provider is silently dropped from `pi --list-models`. This is intentional; users without CN auth don't see the CN option. To verify both providers, set both env vars (or set `MINIMAX_CN_API_KEY=dummy` for testing).

### 4. `message_end` can replace the final message but `message_update` cannot

The agent emits `message_update` for each streaming delta; the event is observable but read-only — the extension cannot mutate the streaming display. `message_end` returns `MessageEndEventResult` with an optional `message` field; if returned, the agent replaces the final message in place via `_replaceMessageInPlace`. The replacement must keep the original message role.

Upstream's `skipThinkingBlock` strips markers on `message_update` (cleaner live display). Our hook only cleans at `message_end` — there's a brief visual flash of `<think>…</think>` during streaming before the hook replaces the final message.

### 5. `registerProvider` accepts `$ENV_VAR` syntax for `apiKey`

The leading-`$` form does env-var interpolation at request time (per the `migrateLegacyRegisterProviderConfigValue` migration path: leading `$` is the modern syntax; bare env-var names trigger a deprecation warning). Use `$MINIMAX_API_KEY`, not `"MINIMAX_API_KEY"`.

### 6. Runtime resolves host packages from the user's global pi; devDependencies exist only for typecheck

At runtime, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` resolve from the user's installed pi (e.g., `/opt/homebrew/lib/node_modules/@earendil-works/...` on macOS Homebrew). The extension declares them in `peerDependencies` (pinned to `0.79.1`) to document the contract and surface a version mismatch warning, and in `devDependencies` (same pin) so `tsc` can resolve types during publish. They are not `dependencies` — `pi install` does not duplicate them under the user's extension directory.

Local typecheck installs use pnpm (see Typecheck section). The `pi-coding-agent` tarball has malformed symlink entries (`@mistralai/mistralai/src`, `.../esm`) that npm's extractor warns about and that, combined with npm's flat-hoisting resolution, leave `import type` from the project unresolvable. pnpm installs cleanly.

### 7. Conventional-commits hook lives globally

`~/.git-template/hooks/commit-msg` validates all commits. Use `type(scope)?!: description` (lowercase description, no trailing period). Allowed types: `build chore ci docs feat fix perf refactor revert style test`.

### 8. SSH GPG signing

`core.hooksPath` and `commit.gpgsign` are pre-configured globally. Use:
```bash
git -c gpg.format=ssh -c user.signingkey=~/.ssh-keys/bw_signing-key-macbook.key commit ...
```
or set `gpg.format=ssh` and `user.signingkey` in the repo's `.git/config` once.

## Repository conventions

- `index.ts` is the only runtime file; no helper modules.
- `package.json` `pi.extensions` field explicitly declares the entry point (pi auto-discovers `index.ts` at root, but the explicit declaration makes distribution unambiguous).
- `tsconfig.json` is dev-only (not in any runtime path); commit it so the typecheck is reproducible.
- Versions: `0.1.0` initial, semantic versioning, MIT.
- Commit message body explains **why**, not **what**; the diff shows what.
