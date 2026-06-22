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
pi install -l ./
pi --provider minimax-m3-cache-fixed --model MiniMax-M3 --session-id my-test-1 -p "We are testing prompt caching. Acknowledge briefly."
pi --provider minimax-m3-cache-fixed --model MiniMax-M3 -c -p "What are we testing?"
# session log: ~/.pi/agent/sessions/--private-tmp-pi-m3-test--/*my-test-1*.jsonl
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

### Install cycle verification

The S07 slice added three per-host install-cycle shell scripts that automate the manual `pi install -l ./` → turn → session-log → `pi remove -l ./` flow documented above. They assert the session log file lands at the host-correct path (`~/.pi/agent/sessions/`, `~/.gsd/agent/sessions/`, or `~/.omp/agent/sessions/`), covering the macOS `/tmp` → `/private/tmp` symlink precedent.

| Host        | Script                                              |
| ----------- | --------------------------------------------------- |
| vanilla pi  | `.gsd/milestones/M001/slices/S07/tasks/T01-pi-install-cycle.sh` |
| omp         | `.gsd/milestones/M001/slices/S07/tasks/T01-omp-install-cycle.sh` |
| gsd         | `.gsd/milestones/M001/slices/S07/tasks/T01-gsd-install-cycle.sh` |

Run an individual script directly (`bash T01-pi-install-cycle.sh`) for ad-hoc UAT, or run the regression check to verify all three scripts are present and syntactically valid:

```bash
node tests/s07-install-cycle-check.mjs
```

The regression check is hermetic (Node 18+ stdlib only, MEM020 pattern) and exits 0 only when all three scripts exist, pass `bash -n`, and AGENTS.md still references them by filename — protecting against accidental script removal.

### omp `/login` auth-login runtime UAT (M003 S02)

The S02 slice added a runtime UAT script under `tests/uat/` that proves the S01 oauth registration reaches omp's `/login` UX end-to-end. Where the S07 install-cycle scripts above prove the *install + session-log surface* (passing `--api-key` explicitly), this script proves the *saved-credential path* — the one `/login` enables — by driving `omp auth-broker login minimax-m3-clean` and asserting the saved key reaches omp's openai-completions driver without `--api-key` on the turn command.

| Artifact | Path | Purpose |
| --- | --- | --- |
| Runtime UAT script | `tests/uat/omp-auth-login.sh` | Snapshot `~/.omp/agent/agent.db` → install → drive `omp auth-broker login` via piped stdin → assert `omp auth-broker list --json` enumerates `minimax-m3-clean` → optionally run end-to-end turn with `MINIMAX_API_KEY` UNSET, NO `--api-key` → grep session log for `cacheRead > 0` → uninstall + restore snapshot. |
| Hermetic regression check | `tests/s02-uat-omp-login-check.mjs` | MEM020-pattern structural test: script exists, `bash -n` passes, contains load-bearing markers (`trap restore EXIT`, `auth-broker login`, `auth-broker list --json`, `m3-s02-uat`, `cacheRead`, `minimax-m3-clean`, `MiniMax-M3`, `M3_UAT_KEY`), turn command does NOT pass `--api-key` (MEM028 guard), AGENTS.md references the script by filename. |
| Two-tier UAT (R1 mitigation) | `M3_UAT_KEY` env var | End-to-end turn requires a real upstream key (cacheRead > 0 only appears after a successful upstream request). The script always runs steps 1–3 (registration + list enumeration); step 4 (end-to-end turn) only runs when `M3_UAT_KEY` is set, otherwise it prints `SKIP` and exits 0. CI keeps the registration-shape proof; maintainers provision a real key for the full runtime proof. |

Run the script directly for ad-hoc UAT:

```bash
# Hermetic registration-shape proof (no real key required):
bash tests/uat/omp-auth-login.sh

# Full end-to-end proof (requires a real upstream MiniMax key):
M3_UAT_KEY=<real-key> bash tests/uat/omp-auth-login.sh
```

Or run the structural regression check:

```bash
node tests/s02-uat-omp-login-check.mjs
```

The hermetic check exits 0 only when all assertions pass. Per R1 (S02 research), `omp auth-broker login minimax-m3-clean` and `omp auth-broker list --json` empirically surface a structural contract gap on omp 16.0.2: `pi.registerProvider({oauth})` registers with the model registry but does NOT route to omp's auth-broker registry. The script reports this gap loudly (FAIL with diagnostic) rather than silently passing — the runtime UAT's purpose is to be the falsifier, not the contract enforcer. The fix path is documented in `.gsd/milestones/M003/slices/S02/S02-RESEARCH.md` (F1–F4) and the D-001 decision.

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

#### Multi-host install: S06 fix (MEM018)

Before S06, `resolveAgentDir()` probed `@earendil-works/pi-coding-agent`
first, then the omp and gsd packages. On a **multi-host dev machine**
(all three pi-family packages present in `node_modules/`, e.g. an
extension author who tests against all three hosts), the probe order
mattered: if `PI_PACKAGE_DIR` was set globally (gsd-pi's loader sets
`PI_PACKAGE_DIR=…/@opengsd/gsd-pi/pkg` to inject its own package
resolution), the vanilla `@earendil-works/pi-coding-agent.getAgentDir()`
returned `~/.gsd/agent` even when the active host was `pi` or `omp`.
This is the MEM011 / MEM018 collision — the `getAgentDir()` call alone
cannot disambiguate the active host on a contaminated `node_modules/`
setup, so all three hosts would end up reading `~/.gsd/agent` (or
whichever dir the env-var shuffle resolved first). User override
files in the correct `~/.pi/agent/` or `~/.omp/agent/` directory
were silently ignored.

S06 closed this with a host-aware priority chain in `resolveAgentDir()`:

1. **`M3_CLEAN_AGENT_DIR` env override** — validated for existence;
   if the dir is missing, log a debug-level warning and fall through.
2. **Host detection** — `process.versions.bun` (omp's runtime
   fingerprint) first, then a normalized `process.argv[1]` substring
   match (`@opengsd/gsd-pi` or `gsd-pi/dist/loader` → gsd;
   `@earendil-works/pi-coding-agent` or `pi-coding-agent/dist/cli` →
   vanilla pi). The gsd check is intentionally placed before the pi
   check because gsd's path also contains `pi-coding-agent` (the
   `@gsd/pi-coding-agent` re-export sits under that directory).
3. **Per-host package-probe order** — the matching host's package is
   tried first, then vanilla pi (the legacy-pi-compat rewrite for omp
   per MEM013 means vanilla is often the resolved module under omp),
   then the remaining host as last resort.
4. **Legacy order** — only reached if no host is detectable
   (future rebranded host). Same order as the pre-S06 behavior, so
   single-host installs are unaffected.

A `console.debug` line at extension-load time logs
`[m3-clean] host=<host> agentDir=<path>`, so users can diagnose
cross-contamination by redirecting stderr (`2>debug.log`). The
priority-1 override is exposed as `host=override` in the log so
test escape hatches are visible. `tests/s06-resolve-agent-dir.mjs`
regression check covers the argv-matching logic.

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

### omp install path is now functional (S04)

S04 closed the static-import gap (see MEM006 + MEM013). The previous
`index.ts` did a static `import { getApiProvider } from "@earendil-works/pi-ai"`
and called `getApiProvider("openai-completions").streamSimple(...)`.
omp's `@oh-my-pi/pi-ai@16.0.2` does **not** export `getApiProvider` —
it exposes `getCustomApi` / `registerCustomApi` instead — so the
static import would have crashed the extension load on omp.

S04 replaced both host-fragile symbols with cross-host bridges that
exist on all three Pi forks:

- `getApiProvider("openai-completions").streamSimple(...)` →
  top-level `streamSimple<TApi>(model, ctx, opts)`. The wrapper now
  passes `{ ...model, api: "openai-completions" }` to the top-level
  function, which dispatches to the built-in driver for that api
  without going through `getApiProvider`.
- `createAssistantMessageEventStream()` (used inside the `cleanStream`
  factory) → `new AssistantMessageEventStream()`. The cross-host
  class constructor exists on all three `@…/pi-ai` versions.

The defensive "openai-completions driver not registered" warning
path (the `if (!driver) throw` guard around the imported
`getApiProvider` result) is also gone — if a host's top-level
`streamSimple` cannot handle the `openai-completions` api, the
underlying driver call now errors at runtime, which is the right
surface for that failure. After S04: `pi --list-models` on omp shows
both `minimax-m3-clean` and `minimax-cn-m3-clean`, and a real
streaming turn on omp produces a session log entry with `cacheRead`
metrics.

### Fail-soft behavior (S02)

The orchestrator does not crash the whole session when this extension
loads on a host that refuses to accept a provider name conflict in
`pi.registerProvider(spec.name, ...)` (validation error throws). In
that case the call is wrapped in try/catch; on throw the affected
provider is skipped and a TUI warning naming the provider is
deferred to `session_start` — no exception propagates out of the
extension factory. Warnings are deferred to `session_start` because
`ctx.ui.notify` is not available in the extension factory — the
same precedent the override-file validation errors use.

### omp `/login` auth surface for custom providers (M003 S01)

The registration shape that surfaces our providers in omp's `/login`
selector is a single `oauth` field on the `pi.registerProvider` config
object:

```ts
pi.registerProvider(spec.name, {
  baseUrl: spec.baseUrl,
  apiKey: spec.apiKey,   // e.g. "$MINIMAX_API_KEY"
  oauth: spec.oauth,     // { name, login, refreshToken, getApiKey }
  api,
  streamSimple: ...,
  models: [...],
});
```

The cross-host contract for that `oauth` block is documented
asymmetry, not a uniform behavior:

- **omp 16.0.2.** `registerProvider` reads `config.oauth` and dispatches
  to `registerOAuthProvider({...config.oauth, id: providerName, sourceId})`.
  Our provider entry then appears in omp's `/login` selector. When the
  user picks it, omp's `AuthStorage.login()` invokes our
  `login({onPrompt, ...})` callback AT LOGIN TIME and persists the
  returned string (recovered via `getApiKey(credentials)`) as the
  `api_key` for that provider. omp's `OAuthProviderInterface.login`
  types the return as `Promise<OAuthCredentials | string>`; both hosts
  funnel through `getApiKey` for the persisted key string, so the
  `OAuthCredentials` shape (`{access, refresh, expires}`) we return is
  the union-typed value.
- **vanilla pi 0.79.1 / gsd-pi.** `registerProvider` accepts the same
  `oauth` shape at the type level (their `ProviderConfig.oauth` is
  `Omit<OAuthProviderInterface, "id">`), but expose their own native
  `/login` API-key picker. **Users on those hosts will not click our
  oauth entry** — they pick the provider from the host's native list
  and paste the key into the host's own dialog. Our `oauth` block is a
  no-op there; the S02 fail-soft `try/catch` around `registerProvider`
  is the safety net for the case where the host validates the shape
  strictly and throws on `login`/`refreshToken`/`getApiKey`.

#### omp safety-net dispatch via `registerOAuthProvider` (M003 S03)

The `pi.registerProvider({oauth})` call does dispatch to omp's
`registerOAuthProvider` internally (verified in omp 16.0.2's
`cli.js`), but the dispatch only fires when
`validateProviderConfiguration` accepts the registration shape and
the surrounding `try/catch` in `makeProvider()` does not short-circuit
the call. On a developer machine where the validation rejects the
shape (e.g. a stricter `M3_COMPAT` check under omp 16.0.2), the
provider is skipped before `registerOAuthProvider` is ever reached
and `omp auth-broker list --json` returns the provider as MISSING
(D-001 / MEM035 — the empirical gap S02 surfaced).

S03 closes this with a host-branched safety-net dispatch in
`index.ts::registerOmpOAuth`. The helper is `await`ed from
`makeProvider` BEFORE the existing `pi.registerProvider` call and
runs only when `detectHost() === "omp"` (the same chain that
`resolveAgentDir()` uses per MEM018). It dynamically
`import("@oh-my-pi/pi-ai/oauth")` for `registerOAuthProvider` and
calls it with `{ ...spec.oauth, id: spec.name, sourceId }`. The
dynamic import lives entirely inside the `if (host === "omp")` branch
per MEM037, so vanilla pi and gsd never attempt to load
`@oh-my-pi/pi-ai/oauth` (the module is not published for those
hosts and a static import would crash extension load). Vanilla pi
and gsd paths are otherwise unchanged — the host-branched dispatch
is additive: the existing `pi.registerProvider` call still runs on
every host for the model registration, and on omp it provides
belt-and-suspenders coverage for the OAuth descriptor even when the
model-registration path is rejected by `validateProviderConfiguration`.
Full root-cause analysis and the verified facts behind the fix live
in `.gsd/milestones/M003/slices/S03/S03-RESEARCH.md`; the static
analysis of omp 16.0.2's `cli.js` line 2438 (the dispatch) and line
676 (the `registerOAuthProvider` function itself) is the empirical
proof that the dispatch exists and that the gap is upstream of it.

#### The `onPrompt`-not-`ctx.ui` rule

The `oauth.login` callback is invoked by the host's `AuthStorage`
**at login time** — long after the extension factory has returned. The
factory's `ctx.ui` is `undefined` by then, so the callback MUST close
over the host-injected `callbacks.onPrompt` channel, not over
`ctx.ui` captured during factory execution. The implementation lives
in `src/core/oauth-login.ts::oauthConfigFor`, where the `login`
function destructures `callbacks.onPrompt` and calls it with a
`{message: "Paste your $ENV_VAR_NAME for <model label>. Input is hidden."}`
prompt. The prompt message references both the env-var name AND the
model label so the user can verify they are pasting the right key into
the right provider's dialog (the
"Prompt labels leaking the env-var name vs the model label" pitfall
documented in the M003 research). This is the largest remaining pain
point in custom-provider auth (MEM027) — every host ships its own
slightly different `OAuthLoginCallbacks` shape, and we deliberately
declare the narrow structural subset we need (`OauthPromptCallbacks`)
locally rather than import any host's `OAuthLoginCallbacks` type.

The env-var fallback (`export MINIMAX_API_KEY=…`) is **retained** for
users who already have it. It remains the primary path on pi/gsd
(where the host's native API-key picker is what they use anyway),
and the `$MINIMAX_API_KEY` syntax in `apiKey: "$MINIMAX_API_KEY"` is
interpolated at request time by `migrateLegacyRegisterProviderConfigValue`.
On omp, the env-var path also works as a fallback if the user prefers
to skip the `/login` dialog.

#### Regression check

`tests/s01-auth-surface.mjs` (hermetic, Node 18+ stdlib only, MEM020
pattern) pins this contract: it re-implements `oauthConfigFor` in
plain JS, cross-checks the body string against a literal regex
extracted from the source (s06's "refactor one without the other
fails" pattern), asserts the prompt message references both the
env-var name and the model label, asserts empty input is rejected
so omp does not persist an empty credential, and re-asserts
`M3_COMPAT.streamIdleTimeoutMs: 30_000` (the MEM017 regression guard
that S05 added and S01 must not undo). After S03 the check has
**21 assertions** (was 18): the three new ones lock in the
host-branched dual-registration path — the `registerOmpOAuth`
helper name, the `host === "omp"` branch guard, and the dynamic
`import("@oh-my-pi/pi-ai/oauth")` from inside the omp branch — so
refactoring the helper without the dynamic import, or hoisting the
dynamic import out of the branch, fails the regression.

## Critical learnings

### 1. The user's installed `pi-ai@0.79.1` does NOT have `compat.skipThinkingBlock`

The upstream fix `pi-mono@b85b91c9` adds it; the published npm version 0.79.1 predates that commit. **Do not** set `compat.skipThinkingBlock: true` in `registerProvider` — the field doesn't exist in the type, tsc will fail. The post-0.1.0 code path strips thinking in flight (see §4 below) and never touches `compat.skipThinkingBlock`. If the upstream field does land in a future `@earendil-works/pi-ai`, do not enable it here without first removing the in-flight `cleanStream` wrapper — the two paths are not safe to combine.

### 2. `pi.registerProvider(name, { models })` REPLACES all models for that provider

Overriding the built-in `minimax` provider would wipe M2.x. Use distinct names (`minimax-m3-cache-fixed`, `minimax-cn-m3-cache-fixed`) and document in README that two `MiniMax-M3` entries appear in `/model` — pick the one with `(cache-fixed)` in the name.

### 3. Provider registration requires the env var to be set for the provider to appear

`ModelRegistry.hasConfiguredAuth()` checks `isConfigValueConfigured(providerApiKey)`. If the env var referenced by `$MINIMAX_CN_API_KEY` is unset, the `minimax-cn-m3-cache-fixed` provider is silently dropped from `pi --list-models`. This is intentional; users without CN auth don't see the CN option. To verify both providers, set both env vars (or set `MINIMAX_CN_API_KEY=dummy` for testing).

### 4. `message_end` is no longer used — `cleanStream` wraps the openai-completions stream in flight

0.2.0 reworked the cleanup strategy from post-hoc to in-flight. The
`cleanStream` wrapper in `src/core/clean-stream.ts` wraps the built-in
`openai-completions` driver and rewrites the event stream in real
time via the `ThinkScanner`: duplicated thinking from M3's
`reasoning_content` / `reasoning` alternation is suppressed, and
`<think>…</think>` spans are filtered out of text deltas (with their
inner content routed to a real thinking block when no reasoning
fields are streamed). The `message_end` hook that 0.1.0 used for the
post-hoc strip is no longer registered — in 0.2.0+ the live display
is clean by the time the assistant message finishes streaming, and
no end-of-turn mutation is needed.

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
