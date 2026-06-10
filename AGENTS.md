# AGENTS.md

## What this is

Standalone pi extension that fixes MiniMax-M3 (built-in `minimax` provider in pi) by routing to `/v1/chat/completions` (passive cache) and stripping duplicated thinking via a `message_end` hook. See `README.md`, `PLAN.md`, `PLAN-DELTA.md`.

## Typecheck

```bash
mkdir -p node_modules/@earendil-works
ln -sf /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
ln -sf /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
npm run check
rm -rf node_modules
```

The symlinks resolve `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` from the user's global pi install. `tsconfig.json` enables `--skipLibCheck` and `--moduleResolution bundler` so transitive type packages don't fail the check.

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
pi --provider minimax-m3 --model MiniMax-M3 --session-id my-test-1 -p "We are testing prompt caching. Acknowledge briefly."
pi --provider minimax-m3 --model MiniMax-M3 -c -p "What are we testing?"
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

## Critical learnings

### 1. The user's installed `pi-ai@0.79.1` does NOT have `compat.skipThinkingBlock`

The upstream fix `pi-mono@b85b91c9` adds it; the published npm version 0.79.1 predates that commit. **Do not** set `compat.skipThinkingBlock: true` in `registerProvider` — the field doesn't exist in the type, tsc will fail. Either:
- (chosen) strip thinking via a `message_end` hook at end-of-stream, or
- cast `compat` to bypass tsc and accept that the field is ignored at runtime

PLAN-DELTA.md documents the choice and the trade-off (brief visual flash during streaming; session log stays clean).

### 2. `pi.registerProvider(name, { models })` REPLACES all models for that provider

Overriding the built-in `minimax` provider would wipe M2.x. Use distinct names (`minimax-m3`, `minimax-cn-m3`) and document in README that two `MiniMax-M3` entries appear in `/model` — pick the one with `(passive cache)` in the name.

### 3. Provider registration requires the env var to be set for the provider to appear

`ModelRegistry.hasConfiguredAuth()` checks `isConfigValueConfigured(providerApiKey)`. If the env var referenced by `$MINIMAX_CN_API_KEY` is unset, the `minimax-cn-m3` provider is silently dropped from `pi --list-models`. This is intentional; users without CN auth don't see the CN option. To verify both providers, set both env vars (or set `MINIMAX_CN_API_KEY=dummy` for testing).

### 4. `message_end` can replace the final message but `message_update` cannot

The agent emits `message_update` for each streaming delta; the event is observable but read-only — the extension cannot mutate the streaming display. `message_end` returns `MessageEndEventResult` with an optional `message` field; if returned, the agent replaces the final message in place via `_replaceMessageInPlace`. The replacement must keep the original message role.

Upstream's `skipThinkingBlock` strips markers on `message_update` (cleaner live display). Our hook only cleans at `message_end` — there's a brief visual flash of `<think>…</think>` during streaming before the hook replaces the final message.

### 5. `registerProvider` accepts `$ENV_VAR` syntax for `apiKey`

The leading-`$` form does env-var interpolation at request time (per the `migrateLegacyRegisterProviderConfigValue` migration path: leading `$` is the modern syntax; bare env-var names trigger a deprecation warning). Use `$MINIMAX_API_KEY`, not `"MINIMAX_API_KEY"`.

### 6. pi uses the global node_modules, not project-local

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` resolve from the user's installed pi (e.g., `/opt/homebrew/lib/node_modules/@earendil-works/...` on macOS Homebrew). The extension's `package.json` does NOT list them as dependencies — declaring them would force re-resolution. For typecheck only, symlink the global packages into a temporary `node_modules/` (see typecheck section above).

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
