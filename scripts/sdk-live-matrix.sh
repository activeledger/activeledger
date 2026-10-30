#!/usr/bin/env bash
#
# sdk-live-matrix.sh - run every SDK's "live" tests against a real local
# Activeledger test network and print a pass/fail/skip matrix.
#
# Every SDK has a live suite that is skipped unless AL_NODES and AL_STORAGE
# point at a running network. Skipped tests prove nothing about whether a real
# node accepts what the SDK signs, so this script boots the network from
# `npm run test:network:serve` (tests/network/serve.ts), points each suite at
# it, and reports what happened.
#
# What it does
#   1. Checks out clean copies (detached git worktrees) of the ledger and of
#      each SDK at its default branch, so local edits and unpushed commits in
#      your working checkouts are neither used nor touched.
#   2. Builds the ledger (`npm ci && npm run build`) and fetches each SDK's
#      dependencies. This is the only phase that may use the network.
#   3. Re-executes itself inside an empty network namespace
#      (`unshare -rn --pid --fork --mount-proc`) with only loopback up. The ledger binds
#      its node ports to ALL interfaces; the namespace is what keeps the
#      testnet off your LAN, and it also means the fixed ports (5509-5540)
#      cannot collide with anything else on the machine. Leaving the
#      namespace kills every process in it.
#   4. Boots the 4-node network, runs each suite one at a time, OFFLINE,
#      against AL_NODES=http://127.0.0.1:5510,... AL_STORAGE=...:5509,...
#      (read from what the network prints), and tears the network down on
#      exit (trap), including on failure or Ctrl-C.
#   5. Prints a matrix and exits non-zero if any SDK failed.
#
# Usage
#   scripts/sdk-live-matrix.sh [options] [SDK...]
#
#   SDK is any of: js python go jvm csharp rust php dart swift
#   With no SDK given, all of them run. "js" has no live suite and is reported
#   as "none".
#
#   Options
#     -l, --list     list the SDK names and exit
#     -k, --keep     keep the work directory (reuse builds on the next run)
#     -h, --help     show this text
#
# Exit status: 0 all selected suites passed (skips allowed); 1 at least one
# suite failed or errored; 2 usage or environment problem.
#
# Environment (defaults assume the sibling-directory layout, i.e. the ledger
# and SDK-* repos are checked out side by side)
#   AL_SDK_ROOT      directory holding the SDK-* repos   [parent of this repo]
#   AL_LEDGER_REPO   the ledger git repo                 [this repo]
#   AL_LEDGER_REF    ledger ref to test                  [origin/master]
#   AL_REF_<SDK>     per-SDK ref, e.g. AL_REF_DART        [origin/master;
#                    origin/main for dart and swift]
#   AL_WORK_DIR      where clean copies, venv and logs go [mktemp -d]
#                    An existing directory is reused as-is (not refreshed)
#                    and is never deleted.
#   AL_KEEP_WORK     1 = keep the work dir afterwards      [0]
#   AL_NODES_COUNT   node count passed to the network      [4]
#   AL_BUILD         protocol build passed to the network  [40100]
#   AL_NODES / AL_STORAGE
#                    If BOTH are already set, no network is booted and the
#                    suites run against yours. Loopback isolation is then
#                    your responsibility.
#   AL_ALLOW_WILDCARD_BIND
#                    1 = if `unshare -rn` is unavailable, run without
#                    isolation (the nodes will listen on all interfaces)
#   AL_PYTHON        python interpreter for the venv       [python3]
#   AL_SKIP_PREPARE  1 = skip the dependency-fetch phase (fully offline)
#   AL_BOOT_TIMEOUT  seconds to wait for the network       [180]
#
# Requires: git, node/npm, util-linux unshare, and the toolchain of each SDK
# you select (python3; java via ./gradlew; go; dotnet; cargo; php+composer;
# dart; swift). Suites run strictly one at a time.
#
# Known limits
#   - Python post-quantum tests need liboqs (built from source on first
#     import); they skip unless it is already present.
#   - Rust skips by returning early, which cargo counts as a pass; this script
#     reads the "SKIP:" lines it prints to move those from pass to skip.
#   - Dart's Falcon package is run as its own process with -j 1 so Falcon is
#     only ever loaded in one isolate (known native-callback crash).

set -uo pipefail

ALL_SDKS=(js python go jvm csharp rust php dart swift)

usage() { sed -n '2,/^set -uo/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; }

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(dirname "$(dirname "$SELF")")"
: "${AL_LEDGER_REPO:=$REPO_ROOT}"
: "${AL_SDK_ROOT:=$(dirname "$AL_LEDGER_REPO")}"
: "${AL_LEDGER_REF:=origin/master}"
: "${AL_NODES_COUNT:=4}"
: "${AL_BUILD:=40100}"
: "${AL_BOOT_TIMEOUT:=180}"
: "${AL_PYTHON:=python3}"
: "${AL_ALLOW_WILDCARD_BIND:=0}"
: "${AL_SKIP_PREPARE:=0}"

log() { printf '[matrix] %s\n' "$*" >&2; }
die() { printf '[matrix] ERROR: %s\n' "$*" >&2; exit 2; }

sdk_dir_name() {
  case "$1" in
    js) echo SDK-JS;; python) echo SDK-Python;; go) echo SDK-Golang;;
    jvm) echo SDK-JVM;; csharp) echo SDK-CSharp;; rust) echo SDK-Rust;;
    php) echo SDK-PHP;; dart) echo SDK-Dart;; swift) echo SDK-Swift;;
  esac
}
sdk_default_ref() { case "$1" in dart|swift) echo origin/main;; *) echo origin/master;; esac; }
sdk_ref() {
  local v="AL_REF_$(echo "$1" | tr a-z A-Z)"
  echo "${!v:-$(sdk_default_ref "$1")}"
}

# Add a detached worktree of repo $1 at ref $2 in dir $3, unless $3 exists.
# Falls back to HEAD with a warning if the ref is missing.
checkout_clean() {
  local repo="$1" ref="$2" dir="$3"
  if [ -d "$dir" ]; then log "reusing $dir"; return 0; fi
  git -C "$repo" rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1 || {
    log "WARN: $ref not found in $repo, using HEAD"; ref=HEAD; }
  git -C "$repo" worktree add -q --detach "$dir" "$ref" >&2 || return 1
  CREATED_WORKTREES+=("$repo|$dir")
}

# ---------------------------------------------------------------------------
# Phase 1 (outer, network allowed): clean copies, builds, dependency fetch
# ---------------------------------------------------------------------------

GRADLE_FLAGS=(--no-daemon -Pkotlin.compiler.execution.strategy=in-process)

prep_sdk() { # best-effort: failures here surface later as a build error
  local sdk="$1" d="$WORK/$(sdk_dir_name "$1")" pkg
  cd "$d" || return 1
  case "$sdk" in
    python)
      [ -x "$WORK/venv/bin/pip" ] || "$AL_PYTHON" -m venv "$WORK/venv"
      "$WORK/venv/bin/pip" install -q -e ".[dev,ec]" ;;
    go) go mod download ;;
    jvm) ./gradlew --offline "${GRADLE_FLAGS[@]}" integrationTestClasses \
           || ./gradlew "${GRADLE_FLAGS[@]}" integrationTestClasses ;;
    csharp) DOTNET_ROLL_FORWARD=Major dotnet restore ;;
    rust) cargo fetch --locked 2>/dev/null || cargo fetch ;;
    php) composer install -q --no-interaction ;;
    dart) dart pub get
      # The Falcon package builds liboqs in a native build hook that downloads
      # a release: run the (skipping) suites once here so that happens now,
      # while the network is allowed, not inside the offline namespace.
      for pkg in activeledger activeledger_falcon; do
        ( cd "packages/$pkg" && env -u AL_NODES -u AL_STORAGE dart test -j 1 test/integration ) || true
      done ;;
    swift) swift package resolve ;;
  esac
}

prepare() {
  checkout_clean "$AL_LEDGER_REPO" "$AL_LEDGER_REF" "$WORK/activeledger" || die "cannot check out ledger"
  local sdk
  for sdk in "${SDKS[@]}"; do
    checkout_clean "$AL_SDK_ROOT/$(sdk_dir_name "$sdk")" "$(sdk_ref "$sdk")" "$WORK/$(sdk_dir_name "$sdk")" \
      || die "cannot check out $(sdk_dir_name "$sdk") (looked in $AL_SDK_ROOT)"
  done
  if [ -z "${AL_NODES:-}" ] || [ -z "${AL_STORAGE:-}" ]; then
    if [ ! -f "$WORK/activeledger/.al-matrix-built" ]; then
      log "building ledger (npm ci && npm run build)"
      ( cd "$WORK/activeledger" && npm ci --no-audit --no-fund >"$WORK/logs/ledger-npm-ci.log" 2>&1 \
          && npm run build >"$WORK/logs/ledger-build.log" 2>&1 && touch .al-matrix-built ) \
        || die "ledger build failed, see $WORK/logs/ledger-*.log"
    fi
  fi
  [ "$AL_SKIP_PREPARE" = 1 ] && return 0
  for sdk in "${SDKS[@]}"; do
    log "fetching dependencies: $sdk"
    prep_sdk "$sdk" >"$WORK/logs/prepare-$sdk.log" 2>&1 \
      || log "WARN: dependency fetch for $sdk failed (see logs/prepare-$sdk.log); continuing"
  done
}

# ---------------------------------------------------------------------------
# Phase 2 (inner, loopback-only namespace): network + suites
# ---------------------------------------------------------------------------

NET_PID=""; NET_TMP=""
stop_network() {
  [ -n "$NET_PID" ] || return 0
  # serve.ts stops its nodes cleanly on SIGINT; give it time, then force.
  kill -INT -- "-$NET_PID" 2>/dev/null || kill -INT "$NET_PID" 2>/dev/null
  local i
  for i in $(seq 1 30); do kill -0 "$NET_PID" 2>/dev/null || break; sleep 1; done
  kill -KILL -- "-$NET_PID" 2>/dev/null
  kill -KILL "$NET_PID" 2>/dev/null
  wait "$NET_PID" 2>/dev/null
  NET_PID=""
  [ -n "$NET_TMP" ] && rm -rf "$NET_TMP"; NET_TMP=""
}

start_network() {
  if [ -n "${AL_NODES:-}" ] && [ -n "${AL_STORAGE:-}" ]; then
    log "using supplied AL_NODES=$AL_NODES AL_STORAGE=$AL_STORAGE"; return 0
  fi
  log "booting $AL_NODES_COUNT-node network (build $AL_BUILD)"
  # Short path on purpose: tsx puts a unix socket under TMPDIR and socket
  # paths are limited to ~100 characters. Removed again by stop_network.
  NET_TMP="$(mktemp -d /tmp/alm.XXXXXX)"
  : >"$WORK/logs/network.json"
  # TMPDIR also keeps the nodes' data dirs in a directory only we own.
  ( cd "$WORK/activeledger" && exec setsid env TMPDIR="$NET_TMP" AL_BUILD="$AL_BUILD" \
      AL_NODES_COUNT="$AL_NODES_COUNT" npm run test:network:serve \
      >"$WORK/logs/network.json" 2>"$WORK/logs/network.log" ) &
  NET_PID=$!
  local i
  for i in $(seq 1 "$AL_BOOT_TIMEOUT"); do
    grep -q '"nodes"' "$WORK/logs/network.json" 2>/dev/null && break
    kill -0 "$NET_PID" 2>/dev/null || { tail -20 "$WORK/logs/network.log" >&2; die "network exited during boot"; }
    sleep 1
  done
  grep -q '"nodes"' "$WORK/logs/network.json" || { tail -20 "$WORK/logs/network.log" >&2; die "network not ready after ${AL_BOOT_TIMEOUT}s"; }
  # Read the URLs the network printed instead of assuming the default ports.
  eval "$(node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").pop());
    console.log("export AL_NODES=" + j.nodes.map(n => n.baseUrl).join(","));
    console.log("export AL_STORAGE=" + j.nodes.map(n => n.storageUrl).join(","));
  ' "$WORK/logs/network.json")"
  log "AL_NODES=$AL_NODES"
  log "AL_STORAGE=$AL_STORAGE"
}

declare -A R_P R_F R_S R_RC R_NOTE

# Last match of regex $2 in file $1, as a bare number (0 if none).
last_num() {
  local v; v="$(grep -oE "$2" "$1" | tail -1 | grep -oE '[0-9]+' | tail -1)"; echo "${v:-0}"
}

run_sdk() {
  local sdk="$1" d="$WORK/$(sdk_dir_name "$1")" out="$WORK/logs/$1.log"
  local rc=0 p=0 f=0 s=0 t line pkg
  cd "$d" || { R_RC[$sdk]=99; R_NOTE[$sdk]="no checkout"; return; }
  log "running $sdk"
  case "$sdk" in
    js)
      R_NOTE[$sdk]="no live suite"; R_RC[$sdk]=0; R_P[$sdk]=0; R_F[$sdk]=0; R_S[$sdk]=0; return ;;
    python)
      "$WORK/venv/bin/python" -m pytest tests/integration -rs -q -p no:cacheprovider >"$out" 2>&1; rc=$?
      p=$(last_num "$out" '[0-9]+ passed'); f=$(( $(last_num "$out" '[0-9]+ failed') + $(last_num "$out" '[0-9]+ errors?') ))
      s=$(last_num "$out" '[0-9]+ skipped') ;;
    go)
      go test -count=1 -run TestLive -v ./... >"$out" 2>&1; rc=$?
      p=$(grep -c '^--- PASS' "$out"); f=$(grep -c '^--- FAIL' "$out"); s=$(grep -c '^--- SKIP' "$out") ;;
    jvm)
      ./gradlew integrationTest --offline --rerun-tasks "${GRADLE_FLAGS[@]}" >"$out" 2>&1; rc=$?
      p=$(grep -cE ' PASSED$' "$out"); f=$(grep -cE ' FAILED$' "$out"); s=$(grep -cE ' SKIPPED$' "$out") ;;
    csharp)
      DOTNET_ROLL_FORWARD=Major DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 \
        dotnet test tests/Activeledger.Tests --no-restore --filter "FullyQualifiedName~LiveNetwork" \
        --logger "console;verbosity=normal" >"$out" 2>&1; rc=$?
      p=$(last_num "$out" 'Passed: +[0-9]+'); f=$(last_num "$out" 'Failed: +[0-9]+'); s=$(last_num "$out" 'Skipped: +[0-9]+') ;;
    rust)
      cargo test --offline --test live -- --nocapture --test-threads=2 >"$out" 2>&1; rc=$?
      p=$(last_num "$out" '[0-9]+ passed'); f=$(last_num "$out" '[0-9]+ failed')
      s=$(grep -c '^SKIP:' "$out"); p=$(( p - s )); [ "$p" -lt 0 ] && p=0 ;;
    php)
      vendor/bin/phpunit --testsuite live >"$out" 2>&1; rc=$?
      t=$(last_num "$out" 'Tests: [0-9]+'); [ "$t" = 0 ] && t=$(last_num "$out" '^OK \([0-9]+ tests?')
      f=$(( $(last_num "$out" 'Failures: [0-9]+') + $(last_num "$out" 'Errors: [0-9]+') ))
      s=$(last_num "$out" 'Skipped: [0-9]+'); p=$(( t - f - s )) ;;
    dart)
      : >"$out"
      for pkg in activeledger activeledger_falcon; do
        ( cd "packages/$pkg" && dart test -j 1 -r expanded test/integration ) >"$out.$pkg" 2>&1 || rc=1
        cat "$out.$pkg" >>"$out"
        line=$(grep -oE '[0-9]{2}:[0-9]{2} \+[0-9]+( ~[0-9]+)?( -[0-9]+)?: ' "$out.$pkg" | tail -1)
        p=$(( p + $(echo "$line" | grep -oE '\+[0-9]+' | tr -d + | head -1 | grep . || echo 0) ))
        s=$(( s + $(echo "$line" | grep -oE '~[0-9]+' | tr -d '~' | head -1 | grep . || echo 0) ))
        f=$(( f + $(echo "$line" | grep -oE ' -[0-9]+' | tr -d ' -' | head -1 | grep . || echo 0) ))
      done ;;
    swift)
      swift test --filter LiveNetworkTests >"$out" 2>&1; rc=$?
      line=$(grep -E 'Executed [0-9]+ tests?, with' "$out" | tail -1)
      t=$(echo "$line" | grep -oE 'Executed [0-9]+' | grep -oE '[0-9]+')
      f=$(echo "$line" | grep -oE '[0-9]+ failures?' | grep -oE '[0-9]+' | head -1)
      s=$(echo "$line" | grep -oE '[0-9]+ tests? skipped' | grep -oE '[0-9]+' | head -1)
      t=${t:-0}; f=${f:-0}; s=${s:-0}; p=$(( t - f - s )) ;;
  esac
  R_P[$sdk]=$p; R_F[$sdk]=$f; R_S[$sdk]=$s; R_RC[$sdk]=$rc
}

print_matrix() {
  local sdk status any_fail=0 p f s rc note
  echo
  echo "SDK       RESULT  PASS  FAIL  SKIP  NOTE"
  echo "--------  ------  ----  ----  ----  ----"
  for sdk in "${SDKS[@]}"; do
    if [ "$sdk" = js ]; then
      printf '%-8s  %-6s  %4s  %4s  %4s  %s\n' "$sdk" none - - - "${R_NOTE[$sdk]:-no live suite}"; continue; fi
    p=${R_P[$sdk]:-0}; f=${R_F[$sdk]:-0}; s=${R_S[$sdk]:-0}; rc=${R_RC[$sdk]:-99}; note=${R_NOTE[$sdk]:-}
    if [ "$f" -gt 0 ]; then status=FAIL
    elif [ "$rc" -ne 0 ]; then status=ERROR; note="exit $rc, see logs/$sdk.log${note:+; $note}"
    elif [ "$p" -eq 0 ] && [ "$s" -eq 0 ]; then status=ERROR; note="no tests were counted${note:+; $note}"
    elif [ "$p" -eq 0 ]; then status=SKIP
    else status=PASS; fi
    if [ "$status" = FAIL ] || [ "$status" = ERROR ]; then any_fail=1; fi
    printf '%-8s  %-6s  %4s  %4s  %4s  %s\n' "$sdk" "$status" "$p" "$f" "$s" "$note"
  done
  echo
  echo "logs: $WORK/logs"
  return $any_fail
}

inner() {
  ip link set lo up 2>/dev/null || true
  trap 'stop_network' EXIT
  trap 'exit 130' INT TERM
  start_network
  local sdk
  for sdk in "${SDKS[@]}"; do run_sdk "$sdk"; done
  stop_network
  print_matrix
  exit $?
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

SDKS=(); KEEP="${AL_KEEP_WORK:-0}"; INNER=0
CREATED_WORKTREES=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -l|--list) printf '%s\n' "${ALL_SDKS[@]}"; exit 0 ;;
    -k|--keep) KEEP=1 ;;
    --inner) INNER=1 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) case " ${ALL_SDKS[*]} " in *" $1 "*) SDKS+=("$1");; *) die "unknown SDK '$1' (try --list)";; esac ;;
  esac
  shift
done
[ ${#SDKS[@]} -gt 0 ] || SDKS=("${ALL_SDKS[@]}")
mapfile -t SDKS < <(printf '%s\n' "${SDKS[@]}" | awk '!seen[$0]++')

if [ "$INNER" = 1 ]; then
  [ -n "${WORK:-}" ] || die "--inner is internal"
  inner
fi

command -v git >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found"

SUPPLIED_WORK=0
if [ -n "${AL_WORK_DIR:-}" ]; then WORK="$AL_WORK_DIR"; [ -d "$WORK" ] && SUPPLIED_WORK=1
else WORK="$(mktemp -d "${TMPDIR:-/tmp}/al-sdk-matrix.XXXXXX")"; fi
mkdir -p "$WORK/logs"; WORK="$(cd "$WORK" && pwd)"; export WORK

cleanup() {
  local e
  if [ "$KEEP" = 1 ] || [ "$SUPPLIED_WORK" = 1 ]; then
    log "work directory kept: $WORK"; return
  fi
  for e in "${CREATED_WORKTREES[@]}"; do
    git -C "${e%%|*}" worktree remove --force "${e#*|}" >/dev/null 2>&1
    git -C "${e%%|*}" worktree prune >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Inside the user namespace we are uid 0, and Java resolves ~ from passwd
# (/root), not from $HOME; pin Gradle's home to the real one.
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"

prepare

ISOLATE=(unshare -rn --pid --fork --mount-proc)
if ! unshare -rn --pid --fork --mount-proc true 2>/dev/null; then
  [ "$AL_ALLOW_WILDCARD_BIND" = 1 ] || die "cannot create a network namespace (unshare -rn). The ledger binds its node ports to all interfaces; refusing to start. Set AL_ALLOW_WILDCARD_BIND=1 to run anyway."
  log "WARN: no network namespace; nodes will listen on all interfaces"
  ISOLATE=()
fi

"${ISOLATE[@]}" env WORK="$WORK" bash "$SELF" --inner "${SDKS[@]}"
rc=$?
exit $rc
