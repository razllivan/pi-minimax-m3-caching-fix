# Implementation TODO

Following PLAN.md execution order, with PLAN-DELTA.md adjustments.

## Tasks

- [x] T1. `package.json` — declare the pi package
- [x] T2. `index.ts` — register providers + `message_end` thinking-strip hook
- [x] T7-partial. Sanity check: `tsc --noEmit` and `pi --list-models`
- [x] T3. `README.md` — install, usage, troubleshooting, retirement
- [x] T4. `CHANGELOG.md` — initial entry
- [x] T5. `LICENSE` — MIT
- [x] T6. `.gitignore`
- [x] T7-full + T8. Real round-trip verification (cache hits, no duplicate thinking)
- [x] T9. Document upstream-merge path (covered in README)
- [x] Final review + commit (`df10c7a`)

## Verification Summary

| Check | Status |
|-------|--------|
| `npm run check` (tsc clean) | ✓ |
| `pi --list-models` shows `minimax-m3` | ✓ |
| `pi --list-models` shows `minimax-cn-m3` (with `MINIMAX_CN_API_KEY`) | ✓ |
| Multi-turn cache test (4 turns, system prompt cached) | ✓ — 99% hit rate from turn 2 |
| Thinking-strip hook (`message_end` removes `<think>...</think>`) | ✓ |
| Session log has no `thinking` blocks, no markers in assistant text | ✓ |
| Conventional-commits hook accepts message | ✓ |
| SSH GPG signature verifies | ✓ |
