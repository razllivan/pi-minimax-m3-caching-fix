# pi-minimax-m3

A standalone [pi](https://github.com/badlogic/pi-mono) extension that fixes two
issues with the built-in **MiniMax-M3** integration:

1. **Silent over-billing on the Anthropic-compatible endpoint.** M3's
   `/anthropic/v1/messages` endpoint ignores `cache_control` markers, so every
   turn was billed at the full input price ($0.60/Mtok) instead of the
   cache-read price ($0.12/Mtok). M3 *does* support passive/automatic prompt
   caching on its OpenAI-compatible endpoint (`/v1/chat/completions`).
2. **Duplicated thinking in the response.** M3 emits thinking content twice:
   once in `reasoning_content` (consumed by pi as a `thinking` block) and once
   in `content` wrapped in `<think>…</think>` markers (which would otherwise
   appear inside the visible text).

This extension registers two new providers — `minimax-m3-clean` and
`minimax-cn-m3-clean` — that route MiniMax-M3 to the OpenAI-compatible
endpoint so passive caching works. The thinking cleanup is performed
**during the stream** by wrapping the built-in `openai-completions`
`streamSimple` driver and rewriting the event stream in flight: duplicated
thinking from M3's `reasoning_content` / `reasoning` field alternation is
suppressed, `<think>…</think>` spans are filtered out of text deltas (and
their inner content is routed to a real thinking block when no reasoning
fields were streamed), and `text_start` is deferred until the first
non-whitespace character.

It mirrors the upstream fix in
[`pi-mono@b85b91c9`](https://github.com/badlogic/pi-mono/commit/b85b91c9)
("route MiniMax-M3 to openai-completions for passive caching") so users can
get the fix on any pi version without waiting for an upstream release.

## Install

From npm:

```bash
pi install npm:@razllivan/pi-minimax-m3-caching-fix
```

From a git checkout (latest, or pinned):

```bash
pi install git:github.com/razllivan/pi-minimax-m3-caching-fix
pi install git:github.com/razllivan/pi-minimax-m3-caching-fix@v0.2.1
```

For local development from a clone:

```bash
git clone https://github.com/razllivan/pi-minimax-m3-caching-fix
pi install ./pi-minimax-m3-caching-fix
```

The extension reuses the env vars you already have for the built-in `minimax`
provider — no new credentials required:

| Provider              | Env var                | Endpoint                         |
| --------------------- | ---------------------- | -------------------------------- |
| minimax-m3-clean      | `MINIMAX_API_KEY`      | `https://api.minimax.io/v1`      |
| minimax-cn-m3-clean   | `MINIMAX_CN_API_KEY`   | `https://api.minimaxi.com/v1`    |

## Features

- **Works on three Pi-family hosts.** One install, same provider
  names regardless of which pi-family you run:
  - **vanilla pi** — [`@earendil-works/pi-coding-agent@0.79.1`](https://github.com/badlogic/pi-mono)
  - **gsd-pi** — [`@opengsd/gsd-pi`](https://www.npmjs.com/package/@opengsd/gsd-pi) ([github.com/open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi)) (a pi fork that ships its own gsd tooling). The gsd host is not pinned in `peerDependencies` because its internal package name is not published to npm; the extension's runtime `resolveAgentDir` fallback chain still finds a match via gsd-pi's loader-side `NODE_PATH` injection.
  - **Oh my Pi (omp)** — [`@oh-my-pi/pi-coding-agent@16.0.2`](https://www.npmjs.com/search?q=%40oh-my-pi%2Fpi-coding-agent). Tested end-to-end on omp 16.0.2 with a real streaming turn: `cacheRead: 34751`, `stopReason: stop`, no fallback to the built-in provider needed.
  
  Pick the model with `(clean)` in the name in `/model` and the rest works the same on all three hosts.
- **Tunable `contextWindow`.** The default 1M-token window is fine for most sessions, but you can cap it without forking the extension. Drop a `m3-clean-overrides.json` in the active agent config directory and the registered `MiniMax-M3` model picks up your `contextWindow` on startup. Full schema and per-host paths in [Tuning context window](#tuning-context-window) below.

## Quickstart (for the impatient)

```bash
# 1. Make sure your MiniMax API key is exported
export MINIMAX_API_KEY="sk-..."

# 2. Install the extension
pi install npm:@razllivan/pi-minimax-m3-caching-fix

# 3. Restart any running pi session, then start one
pi

# 4. Inside pi, switch the model
/model
#   pick:  minimax-m3-clean / MiniMax-M3 (clean)

# 5. Verify caching — look at the footer or session log
#    Turn 1: ~99% cache miss (system prompt being written to cache)
#    Turn 2+: ~99% cache read (system prompt being reused)
```

That's it. No new credentials, no config file, no restart of the upstream
`minimax` provider. Just pick the right model in `/model` and the rest
happens automatically.

## Use

1. Run `pi`.
2. Open the model picker with `/model`.
3. Pick **`minimax-m3-clean / MiniMax-M3 (clean)`** for the
   global endpoint or
   **`minimax-cn-m3-clean / MiniMax-M3 (clean — CN)`** for the
   China endpoint.
4. Send a prompt. The first turn is a cache miss; subsequent turns of the same
   session show a `CH` (cache hit rate) in the footer as the system prompt
   gets reused.

In the session log, the `usage` object on each assistant message shows the
cache reads. For example, a 3-turn session looks like:

| Turn | input | cacheRead | Hit rate |
| ---- | ----- | --------- | -------- |
| 1    | 8932  | 114       | 1%       |
| 2    | 128   | 8946      | 99%      |
| 3    | 128   | 8946      | 99%      |

## Tuning context window

The built-in model advertises M3's full 1M-token context. To lower it (for
example, to cap token spend on long sessions, or to fit a UI that expects a
specific window), create `m3-clean-overrides.json` in the active agent
config directory:

| Pi fork        | Path                                                     |
| -------------- | -------------------------------------------------------- |
| vanilla pi     | `~/.pi/agent/m3-clean-overrides.json`                    |
| omp            | `~/.omp/agent/m3-clean-overrides.json`                   |
| gsd            | `~/.gsd/agent/m3-clean-overrides.json`                   |

The file is detected automatically — no env vars to set. Schema:

```json
{
  "minimax-m3-clean": {
    "MiniMax-M3": { "contextWindow": 131072 }
  },
  "minimax-cn-m3-clean": {
    "MiniMax-M3": { "contextWindow": 32768 }
  }
}
```

Notes:

- Only `contextWindow` is honored. For full model replacement (cost,
  `compat`, `headers`, etc.), use `models.json` instead.
- Both providers share the same M3 model, so the first valid
  `contextWindow` in the file wins. Splitting per provider is
  intentionally unsupported here — keep the values consistent.
- `contextWindow` must be a positive number. Non-positive or non-numeric
  values are ignored and reported via a TUI notification at session
  start; the field falls back to the built-in default (1M).
- The file is read once when pi starts (or on `/reload`). Editing the
  file does not hot-reload the running session — restart pi or run
  `/reload` to apply.
- When the file is missing, the extension silently uses the built-in
  defaults. No TUI notification.

## Why a separate provider (not overriding the built-in)

`pi.registerProvider(name, { models })` **replaces** every model registered
for that provider. There are two ways that breaks the built-in integration:

- Override `minimax` with `baseUrl` only — this lumps M2.x onto the
  OpenAI-compatible endpoint too, breaking M2.x.
- Override `minimax` with new `models` — this wipes M2.x from the registry.

So this extension registers new provider names (`minimax-m3-clean`,
`minimax-cn-m3-clean`) that don't collide with `minimax` or
`minimax-cn`. Users opt in by switching the model in `/model`. The built-in
`minimax / MiniMax-M3` model is still listed — **pick the one with
"(clean)" in the name**.

## Limitations

- **Two `MiniMax-M3` entries in `/model`.** The built-in (broken, billing at
  full input price) and the extension's (clean) both appear. Pick the one
  with `(clean)` in the name.
- **Requires both env vars for both providers to show.** pi only lists
  providers that have auth configured. If you only have `MINIMAX_API_KEY`,
  only `minimax-m3-clean` shows up; set `MINIMAX_CN_API_KEY` (even to a
  dummy value) to also see `minimax-cn-m3-clean`.

## How the fix works

The extension does two things:

1. **Routes M3 to `/v1/chat/completions`** by registering the two new
   providers under a custom `api` id (the provider name) so the wrapper
   below only intercepts these models. The model metadata mirrors
   `packages/ai/src/models.generated.ts` from the upstream fix:
   `input: ["text", "image"]`, `reasoning: true`, cost
   `$0.6 / $2.4 / $0.12` per million tokens, 1M-token context window, 512K
   max output.
2. **Cleans M3's thinking in the stream wrapper.** The wrapper sits in
   front of the built-in `openai-completions` `streamSimple` driver and
   rewrites events as they arrive:
   - All driver thinking blocks are merged into ONE thinking block.
     M3 re-streams the same reasoning when it switches between
     `reasoning_content` and `reasoning` fields, which would otherwise
     start a new (truncated) thinking block on every field switch. The
     wrapper dedupes by prefix and emits only the new portion of
     reasoning.
   - A `ThinkScanner` filters `<think>…</think>` spans from text deltas
     in real time and holds back bytes that look like the start of a tag
     so markers split across deltas are classified correctly. If the model
     never streamed reasoning fields, the captured inner content is
     routed to a real thinking block instead of being dropped; otherwise
     it's a duplicate of the reasoning fields and is discarded.
   - `text_start` is deferred until the first non-whitespace character so
     empty / whitespace-only text blocks are not rendered.

   This is the same effect as the upstream `compat.skipThinkingBlock`
   flag, but applied in the stream wrapper because the user's installed
   `@earendil-works/pi-ai` (0.79.1) predates that compat field. When a
   future pi-ai release includes `skipThinkingBlock`, the wrapper
   becomes a thin pass-through and can be deleted.

## Removing the extension (when upstream ships the fix)

When pi-mono ships a release that includes `b85b91c9` (or any release whose
`models.generated.ts` lists `MiniMax-M3` with `api: "openai-completions"`
and `skipThinkingBlock: true`), retire the extension:

```bash
pi remove npm:@razllivan/pi-minimax-m3-caching-fix
```

The built-in `minimax / MiniMax-M3` model will then route correctly out of
the box.

## License

MIT — see [LICENSE](./LICENSE).

## Credits

The in-flight thinking-cleanup wrapper introduced in v0.2.0 (the
`ThinkScanner`, the merged-thinking block, and the deferred `text_start`)
was contributed by Thunder Guardian (Discord: `@Thunder Guardian`).

## Development

```bash
npm run check    # tsc --noEmit using the bundled tsconfig.json
```

The `tsconfig.json` configures `--skipLibCheck` and `--moduleResolution
bundler` so the type check is reproducible without depending on transitive
type packages of the user's installed pi.
