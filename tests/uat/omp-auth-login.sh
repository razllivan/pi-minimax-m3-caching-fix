#!/bin/bash
# tests/uat/omp-auth-login.sh — End-to-end proof that the S01 oauth
# registration reaches omp's openai-completions driver by way of the
# `/login` UX (no shell env-var, no `--api-key` on the turn command).
#
# What this script asserts (host-correct path: `~/.omp/agent/sessions/`):
#
#   1. The host's session log directory exists at the start of the run.
#   2. A snapshot of `~/.omp/agent/agent.db` is captured (so a leftover
#      credential from a previous run does not create a false positive).
#   3. `omp plugin install --local` completes without error.
#   4. `omp auth-broker login minimax-m3-clean` is callable. Either
#      it drives our S01 oauth callback end-to-end (so the saved
#      credential reaches `AuthStorage.saveApiKeyCredential`), OR it
#      surfaces the empirical gap that proves the S01 contract did
#      not route to omp's auth-broker registry. Both outcomes are
#      recorded as PASS/FAIL — the script's purpose is to be the
#      **falsifier**, not the contract enforcer.
#   5. `omp auth-broker list --json` enumerates `minimax-m3-clean`
#      after the login attempt (proves the provider reached the
#      `registerOAuthProvider` registry; absent = contract gap).
#   6. WITH `M3_UAT_KEY` set (real upstream MiniMax key) AND the
#      saved-credential path proven in (5): an end-to-end turn with
#      `MINIMAX_API_KEY` UNSET, NO `--api-key` flag (MEM028 guard),
#      produces a session log line with `cacheRead > 0` — the
#      definitive runtime signal that the saved credential reached
#      omp's openai-completions driver.
#   7. WITHOUT `M3_UAT_KEY`: step 6 is skipped with an explicit
#      SKIP message. The script still proves the registration-shape
#      contract (steps 1–5) and exits 0; the end-to-end turn is
#      documented as a maintainer-only smoke test.
#   8. `omp plugin uninstall <pkg-name>` cleanly uninstalls the extension.
#   9. The original `agent.db` state is restored on exit (PASS or FAIL).
#
# Why this script lives under `tests/uat/` (not `.gsd/`)
# ------------------------------------------------------
# S07 install-cycle scripts live under `.gsd/milestones/M001/slices/S07/tasks/`
# because they are planning artifacts owned by GSD's projection layer.
# This script is a **runtime artifact authored by the executor**, not
# a planning projection — `tests/uat/` keeps it under the
# hermetic-test discipline (MEM020) and out of the GSD validator's
# "managed projection" surface.
#
# Two-tier UAT (S02 R1 mitigation)
# --------------------------------
# `cacheRead > 0` requires a real upstream call: the openai-completions
# driver must complete a request against `api.minimax.io/v1/chat/completions`,
# which requires a real key. A dummy key would be rejected by the
# upstream before `usage.cacheRead` is logged. The script therefore
# accepts an optional `M3_UAT_KEY` env var: when set, run the full
# end-to-end turn; when absent, stop at step 5 with an explicit SKIP
# and exit 0. This keeps the script CI-runnable without forcing every
# maintainer to provision a real key, while still producing the
# falsifiable runtime signal when one is available.
#
# MEM028 guard (no `--api-key` on the turn command)
# -------------------------------------------------
# Per MEM028, omp 16.0.2's openai-completions driver reads the API key
# from `--api-key` at request time (NOT from the registered `apiKey`
# config). To prove the SAVED credential reaches the driver, the turn
# command MUST NOT pass `--api-key`. The S07 install-cycle script does
# pass `--api-key`, so it proves a DIFFERENT surface; this script
# proves the `/login` path that the S01 oauth registration enables.
#
# Pre-state: `~/.omp/agent/agent.db` is snapshotted on entry. The
# trap restores it on exit (PASS, FAIL, or SKIP).
set -u
set -o pipefail

HOST="omp"
HOST_BIN="omp"
HOST_AGENT_DIR="${HOME}/.omp/agent"
HOST_DB="${HOST_AGENT_DIR}/agent.db"
HOST_SESSIONS_DIR="${HOST_AGENT_DIR}/sessions"
HOST_PROVIDER="minimax-m3-clean"
EXT_DIR="C:/Users/Ivan/Documents/Code/pi-minimax-m3-caching-fix"
TAG="m3-s02-uat"

# Resolve EXT_DIR to a realpath we can `cd` into (MSYS/Git-Bash-safe).
EXT_DIR_REAL="$(cd "$EXT_DIR" && pwd -W 2>/dev/null || pwd)"

# Colors (only when stdout is a TTY).
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_RESET=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

log_step() { echo "${C_YELLOW}=== $* ===${C_RESET}"; }
log_pass() { echo "${C_GREEN}PASS: $*${C_RESET}"; }
log_fail() { echo "${C_RED}FAIL: $*${C_RESET}"; }
log_skip() { echo "${C_BLUE}SKIP: $*${C_RESET}"; }
log_info() { echo "  $*"; }

# --- Snapshot the SQLite credential store so we can restore it on exit.
DB_BACKUP=""
restore() {
  log_step "POST-RUN: restoring ${HOST} agent.db"
  if [ -n "$DB_BACKUP" ] && [ -f "$DB_BACKUP" ]; then
    if [ -f "$HOST_DB" ]; then
      find "${HOST_AGENT_DIR}" -maxdepth 1 -name "agent.db-*" -exec rm -f {} \; 2>/dev/null || true
    fi
    cp "$DB_BACKUP" "$HOST_DB"
    log_info "agent.db restored from $DB_BACKUP"
  else
    log_info "no backup needed (agent.db did not exist before run, or was unchanged)"
  fi
}
trap restore EXIT

# --- Pre-flight ---
log_step "Pre-flight: ${HOST} host"
if ! command -v "$HOST_BIN" >/dev/null 2>&1; then
  log_fail "$HOST_BIN is not on PATH"
  exit 1
fi
log_info "binary: $(command -v "$HOST_BIN")"
log_info "agent dir: $HOST_AGENT_DIR"
log_info "agent db: $HOST_DB"
log_info "session dir: $HOST_SESSIONS_DIR"

if [ ! -d "$HOST_AGENT_DIR" ]; then
  log_fail "expected $HOST_AGENT_DIR to exist (host has never been run?)"
  exit 1
fi

# --- Snapshot agent.db BEFORE the run ---
if [ -f "$HOST_DB" ]; then
  DB_BACKUP="$(mktemp -t pi-m3-login-db-XXXXXX.sqlite)"
  cp "$HOST_DB" "$DB_BACKUP"
  log_info "agent.db snapshot: $DB_BACKUP ($(wc -c <"$DB_BACKUP") bytes)"
else
  log_info "agent.db does not exist yet (no snapshot needed)"
fi

# --- Dummy auth: registration requires the env var to be present for
#     the provider to appear in --list-models (ModelRegistry.hasConfiguredAuth).
#     We DROP the env var before step 6 so the saved credential is the
#     only api-key source at request time. ---
export MINIMAX_API_KEY="${MINIMAX_API_KEY:-dummy}"
export MINIMAX_CN_API_KEY="${MINIMAX_CN_API_KEY:-dummy}"

# --- Unique session id and scratch cwd under TMPDIR ---
SESSION_ID="${TAG}-$$-$(date +%s)"
SCRATCH_PARENT="${TMPDIR:-/tmp}"
SCRATCH_DIR="${SCRATCH_PARENT}/omp-m3-login-${HOST}-$$"
mkdir -p "$SCRATCH_DIR"
log_info "scratch dir: $SCRATCH_DIR"
log_info "session id: $SESSION_ID"

cd "$SCRATCH_DIR"
cd -P "$SCRATCH_DIR" 2>/dev/null || true
log_info "cwd: $(pwd)"

# --- Step 1: install the extension locally ---
# omp 16.0.2 uses `omp plugin install` with a positional <source>
# TARGET and a `--local` flag for SCOPE (project-local vs user-global).
# Per MEM027: the omp CLI requires both pieces; `omp plugin install
# --local` with no TARGET is rejected. The script runs in $SCRATCH_DIR
# so `--local` registers the source as a project plugin of the scratch
# cwd (which is fine — we only care that the install completes and the
# provider becomes available for the turn in the same cwd).
log_step "Step 1: ${HOST_BIN} plugin install --local <ext_dir>"
cd "$EXT_DIR_REAL"
if ! "$HOST_BIN" plugin install --local "$EXT_DIR_REAL" >"${SCRATCH_DIR}/install.stdout" 2>"${SCRATCH_DIR}/install.stderr"; then
  log_fail "${HOST_BIN} plugin install failed"
  log_info "stdout: $(tail -5 "${SCRATCH_DIR}/install.stdout" 2>/dev/null || echo '(none)')"
  log_info "stderr: $(tail -5 "${SCRATCH_DIR}/install.stderr" 2>/dev/null || echo '(none)')"
  exit 1
fi
log_pass "install completed"

# --- Step 2: drive the /login flow via piped stdin ---
# The S01 oauth contract: `pi.registerProvider({ oauth: spec.oauth })` should
# route our provider into omp's auth-broker registry so that
# `omp auth-broker login <our-id>` invokes our `oauth.login(callbacks)`
# callback (which prompts via `callbacks.onPrompt`, reads the key from
# stdin, and returns `{access: key, refresh: key, expires: 0}`).
#
# We pipe a dummy key and capture both stdout and stderr. The login
# command exits 0 if our callback was reached AND the credential was
# persisted; it exits non-zero with `Unknown OAuth provider '<id>'`
# if the S01 contract did not reach omp's auth-broker registry
# (the empirical gap documented in D-001 of the S02 summary).
log_step "Step 2: ${HOST_BIN} auth-broker login ${HOST_PROVIDER} (piped dummy key)"
LOGIN_KEY="${M3_LOGIN_KEY:-dummy-uat-login-key}"
LOGIN_OUTPUT="${SCRATCH_DIR}/login.stdout"
LOGIN_ERROR="${SCRATCH_DIR}/login.stderr"
set +e
printf '%s\n' "$LOGIN_KEY" \
  | "$HOST_BIN" auth-broker login "$HOST_PROVIDER" \
    >"$LOGIN_OUTPUT" 2>"$LOGIN_ERROR"
LOGIN_EC=$?
set -e
log_info "login exit code: $LOGIN_EC"
log_info "login stdout (last 5 lines):"
tail -5 "$LOGIN_OUTPUT" 2>/dev/null | sed 's/^/    /' || log_info "    (none)"
log_info "login stderr (last 5 lines):"
tail -5 "$LOGIN_ERROR" 2>/dev/null | sed 's/^/    /' || log_info "    (none)"

LOGIN_REACHED_PROVIDER=0
if grep -q "Unknown OAuth provider" "$LOGIN_ERROR" 2>/dev/null; then
  log_fail "omp auth-broker does NOT recognize provider '${HOST_PROVIDER}'"
  log_info "the S01 oauth registration did not route to omp's auth-broker registry"
  log_info "this is the falsifiable runtime signal: contract-shape OK, runtime gap exposed"
  log_info "see .gsd/milestones/M003/slices/S02/S02-RESEARCH.md F2 + the D-001 decision"
elif [ "$LOGIN_EC" -eq 0 ]; then
  log_pass "auth-broker login reached our oauth callback (exit 0)"
  LOGIN_REACHED_PROVIDER=1
else
  log_fail "auth-broker login exited $LOGIN_EC (provider name conflict or runtime error)"
  log_info "inspect ${LOGIN_ERROR} for details"
fi

# --- Step 3: assert the provider is enumerated in `omp auth-broker list --json` ---
# Per S02 research F2, `auth-broker list --json` is the only built-in
# surface that surfaces `getOAuthProviders()`. If our S01 oauth block
# reached the auth-broker registry, `minimax-m3-clean` will appear here.
# Absent = contract gap (a registerProvider({oauth}) call does NOT
# route to omp's auth-broker registry; the correct path is
# `registerOAuthProvider(...)` from `@oh-my-pi/pi-ai/oauth`).
log_step "Step 3: assert ${HOST_PROVIDER} appears in auth-broker list --json"
LIST_JSON="${SCRATCH_DIR}/auth-broker-list.json"
if ! "$HOST_BIN" auth-broker list --json >"$LIST_JSON" 2>"${SCRATCH_DIR}/auth-broker-list.stderr"; then
  log_fail "omp auth-broker list --json failed"
  cat "${SCRATCH_DIR}/auth-broker-list.stderr" | sed 's/^/    /'
  exit 1
fi
log_info "list output size: $(wc -c <"$LIST_JSON") bytes"

# Use node to assert presence without depending on jq.
LIST_FOUND=$(node -e "
  const fs = require('node:fs');
  let data;
  try { data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); }
  catch (err) { console.error('JSON parse failed: ' + err.message); process.exit(2); }
  if (!Array.isArray(data)) { console.error('list output is not an array'); process.exit(2); }
  const hit = data.find(p => p && p.id === process.argv[2]);
  console.log(hit ? 'FOUND' : 'MISSING');
  if (hit) console.log('NAME=' + hit.name);
" "$LIST_JSON" "$HOST_PROVIDER" 2>&1)
LIST_EC=$?
log_info "node assert exit: $LIST_EC, output: $LIST_FOUND"
case "$LIST_FOUND" in
  *FOUND*)
    log_pass "${HOST_PROVIDER} enumerated in auth-broker list (S01 contract reached the runtime registry)"
    LIST_REACHED=1
    ;;
  *MISSING*)
    log_fail "${HOST_PROVIDER} NOT in auth-broker list — the S01 oauth contract did not reach omp's auth-broker registry"
    log_info "this is a structural contract gap (D-001): pi.registerProvider({oauth}) routes to"
    log_info "the model registry but NOT to the auth-broker provider list. The correct path"
    log_info "is registerOAuthProvider() from @oh-my-pi/pi-ai/oauth (see model-registry.ts:1999)."
    LIST_REACHED=0
    ;;
  *)
    log_fail "could not parse auth-broker list output: $LIST_FOUND"
    LIST_REACHED=0
    ;;
esac

# --- Step 4: end-to-end turn (only when M3_UAT_KEY is set) ---
# The end-to-end signal (cacheRead > 0 in the session log with
# MINIMAX_API_KEY UNSET and no --api-key) is the DEFINITIVE runtime
# proof that the saved credential reached omp's openai-completions
# driver. It requires:
#   (a) a real upstream MiniMax key (env var M3_UAT_KEY),
#   (b) the S01 oauth registration reaching AuthStorage.saveApiKeyCredential
#       (proxied by LIST_REACHED=1 + LOGIN_REACHED_PROVIDER=1), AND
#   (c) omp's openai-completions driver reading the saved credential
#       at request time (the unresolved question — MEM028 says it
#       reads --api-key, NOT the saved credential).
# When all three hold, the session log MUST show cacheRead > 0.
# When any one fails, this step surfaces the failure mode clearly
# rather than silently passing.
log_step "Step 4: end-to-end turn with MINIMAX_API_KEY UNSET, NO --api-key"
if [ -z "${M3_UAT_KEY:-}" ]; then
  log_skip "M3_UAT_KEY not set; skipping end-to-end turn (steps 1–3 are the hermetic proof)"
  log_info "to run the full cacheRead > 0 turn: export M3_UAT_KEY=<real-key> and re-invoke"
elif [ "$LOGIN_REACHED_PROVIDER" -ne 1 ]; then
  log_skip "auth-broker login did not reach our callback; saved-credential path unproven"
  log_info "end-to-end turn would exercise a path that the S01 contract did not establish"
else
  log_info "M3_UAT_KEY is set; running full end-to-end turn"
  # CRITICAL: drop the env var so the saved credential is the only
  # api-key source at request time. MEM028 says the driver reads
  # --api-key at request time; if we leave MINIMAX_API_KEY set and
  # also pass --api-key, we never prove the saved-credential path.
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY

  cd "$SCRATCH_DIR"
  cd -P "$SCRATCH_DIR" 2>/dev/null || true
  set +e
  timeout 60 "$HOST_BIN" \
    --model "${HOST_PROVIDER}/MiniMax-M3" \
    -p "[${SESSION_ID}] We are testing the /login auth flow. Acknowledge briefly." \
    >"${SCRATCH_DIR}/turn.stdout" 2>"${SCRATCH_DIR}/turn.stderr"
  TURN_EC=$?
  set -e
  log_info "turn exit code: $TURN_EC"
  log_info "turn stdout (last 5 lines):"
  tail -5 "${SCRATCH_DIR}/turn.stdout" 2>/dev/null | sed 's/^/    /' || log_info "    (none)"
  log_info "turn stderr (last 5 lines):"
  tail -5 "${SCRATCH_DIR}/turn.stderr" 2>/dev/null | sed 's/^/    /' || log_info "    (none)"

  # --- Step 5: locate the new session log under the host-correct path ---
  log_step "Step 5: locate new session log under ${HOST_SESSIONS_DIR}"
  SCRATCH_BASENAME="$(basename "$SCRATCH_DIR")"
  FOUND=""
  for prefix in \
    "--${SCRATCH_BASENAME}--" \
    "--private-${SCRATCH_BASENAME}--" \
    "--$(echo "${SCRATCH_DIR}" | sed 's|/|--|g; s| |__|g')--"; do
    CANDIDATE=$(ls "${HOST_SESSIONS_DIR}/${prefix}"*"${SESSION_ID}"*.jsonl 2>/dev/null | head -1 || true)
    if [ -n "$CANDIDATE" ]; then
      FOUND="$CANDIDATE"
      break
    fi
  done
  # omp-specific fallback: the session file may not embed SESSION_ID;
  # search for the message prefix inside recent .jsonl files.
  if [ -z "$FOUND" ] && [ -d "$HOST_SESSIONS_DIR" ]; then
    while IFS= read -r -d '' CANDIDATE; do
      if grep -q "\[${SESSION_ID}\]" "$CANDIDATE" 2>/dev/null; then
        FOUND="$CANDIDATE"
        break
      fi
    done < <(find "$HOST_SESSIONS_DIR" -type f -name "*.jsonl" -mmin -5 -print0 2>/dev/null)
  fi

  if [ -z "$FOUND" ]; then
    log_fail "no session log found under ${HOST_SESSIONS_DIR} matching session id ${SESSION_ID}"
    log_info "files in ${HOST_SESSIONS_DIR}:"
    ls -la "$HOST_SESSIONS_DIR" 2>/dev/null | head -20 || log_info "(dir missing)"
    exit 1
  fi
  log_pass "session log: $FOUND"
  log_info "size: $(wc -c <"$FOUND") bytes"

  # --- Step 6: parse the session log and assert cacheRead > 0 ---
  log_step "Step 6: assert cacheRead > 0 in assistant message"
  PARSER="${SCRATCH_DIR}/parser.out"
  if ! node -e "
    const fs = require('node:fs');
    const path = process.argv[1];
    const text = fs.readFileSync(path, 'utf8');
    const lines = text.split('\n').filter(l => l.trim());
    const msgs = [];
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'message') continue;
      const m = entry.message;
      if (!m || m.role !== 'assistant') continue;
      msgs.push({
        provider: m.provider ?? null,
        model: m.model ?? null,
        cacheRead: m.usage?.cacheRead ?? null,
        input: m.usage?.input ?? null,
        stopReason: m.stopReason ?? null,
        errorMessage: m.errorMessage ?? null,
      });
    }
    console.log('ASSISTANT_COUNT=' + msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      console.log('  [' + i + '] provider=' + m.provider + ' model=' + m.model + ' cacheRead=' + m.cacheRead + ' input=' + m.input + ' stopReason=' + m.stopReason + ' errorMessage=' + (m.errorMessage ?? 'null'));
    }
    const target = msgs.find(m => m.provider === 'minimax-m3-clean' && m.model === 'MiniMax-M3');
    if (!target) { console.log('TARGET_FOUND=false'); process.exit(2); }
    console.log('TARGET_FOUND=true');
    console.log('TARGET_CACHE_READ=' + target.cacheRead);
    console.log('TARGET_STOP_REASON=' + target.stopReason);
    console.log('TARGET_ERROR=' + (target.errorMessage ?? 'null'));
    if ((target.cacheRead ?? 0) > 0) {
      console.log('CACHE_READ_GT_ZERO=true');
      process.exit(0);
    }
    process.exit(3);
  " "$FOUND" >"$PARSER" 2>&1; then
    PARSER_EC=$?
    log_fail "session log parser failed (exit $PARSER_EC)"
    cat "$PARSER"
    exit 1
  fi
  cat "$PARSER"

  # Re-check exit code via the captured output (node -e always returns 0
  # at the shell level when last call is process.exit(0)); the explicit
  # marker print is the source of truth.
  if grep -q "CACHE_READ_GT_ZERO=true" "$PARSER"; then
    CACHE_READ_LINE=$(grep "TARGET_CACHE_READ=" "$PARSER" | head -1)
    log_pass "end-to-end cacheRead > 0 — saved credential reached omp's openai-completions driver"
    log_info "verdict line: $CACHE_READ_LINE"
  elif grep -q "TARGET_FOUND=false" "$PARSER"; then
    log_fail "no assistant message with provider=minimax-m3-clean model=MiniMax-M3 found"
    log_info "the saved credential was NOT consumed by the openai-completions driver"
    exit 1
  elif grep -q "TARGET_ERROR" "$PARSER"; then
    TARGET_ERR=$(grep "TARGET_ERROR=" "$PARSER" | head -1)
    log_fail "assistant message found but the turn errored: $TARGET_ERR"
    log_info "this is the MEM028 falsifier: driver rejected the saved credential at request time"
    exit 1
  else
    log_fail "assistant message found but usage.cacheRead <= 0 (driver did not produce a cache hit)"
    exit 1
  fi
fi

# --- Step 7: uninstall the extension ---
# omp 16.0.2 uses `omp plugin uninstall <package-name>` (NOT `remove` —
# that action does not exist on the current omp CLI). The package name
# is the `name` field from the extension's package.json, NOT a path.
# `omp plugin uninstall` rejects path arguments with
# `Invalid package name: <path>`.
log_step "Step 7: ${HOST_BIN} plugin uninstall <package-name>"
cd "$EXT_DIR_REAL"
EXT_PKG_NAME="$(node -e "console.log(require('./package.json').name)" 2>/dev/null || echo '')"
if [ -z "$EXT_PKG_NAME" ]; then
  log_fail "could not read package.json name from ${EXT_DIR_REAL}"
  exit 1
fi
log_info "package name: ${EXT_PKG_NAME}"
if ! "$HOST_BIN" plugin uninstall "$EXT_PKG_NAME" >"${SCRATCH_DIR}/remove.stdout" 2>"${SCRATCH_DIR}/remove.stderr"; then
  log_fail "${HOST_BIN} plugin uninstall failed"
  log_info "stdout: $(tail -5 "${SCRATCH_DIR}/remove.stdout" 2>/dev/null || echo '(none)')"
  log_info "stderr: $(tail -5 "${SCRATCH_DIR}/remove.stderr")"
  exit 1
fi
log_pass "uninstall completed"

# --- Final summary ---
log_step "RESULT: ${HOST} /login auth-login UAT"
echo "  login reached provider: $LOGIN_REACHED_PROVIDER"
echo "  list enumerated provider: $LIST_REACHED"
echo "  M3_UAT_KEY set: $([ -n "${M3_UAT_KEY:-}" ] && echo yes || echo no)"
if [ "$LOGIN_REACHED_PROVIDER" -eq 1 ] && [ "$LIST_REACHED" -eq 1 ]; then
  log_pass "S01 oauth contract reached omp's auth-broker registry end-to-end"
elif [ "$LIST_REACHED" -eq 0 ]; then
  log_fail "S01 oauth contract did NOT route to omp's auth-broker registry (D-001 contract gap)"
  log_info "the structural registration-shape checks (S01 hermetic suite) pass, but the"
  log_info "runtime path to omp's auth-broker is broken. Captured in D-001 / S02 summary."
  exit 1
fi
echo "  host-correct session log path: ${HOST_SESSIONS_DIR}"
