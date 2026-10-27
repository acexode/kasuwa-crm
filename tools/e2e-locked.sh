#!/usr/bin/env bash
# Runs the e2e suite under the one machine-wide lock (T-0152; brief section 7.2).
#
#   tools/e2e-locked.sh [playwright args...]     ->     pnpm test:e2e -- [playwright args...]
#
# Docker Desktop crashed about eight times during the UI programme when two e2e runs
# overlapped, so only one runs at a time. The lock is a directory taken with `mkdir`,
# which is atomic, and it holds owner.pid (the same convention as tools/lead-verify.sh).
# It lives outside the checkout, so every worktree meets the same lock.
#
#   KASUWA_E2E_LOCK_DIR      the lock directory   (default: ${TMPDIR:-/tmp}/kasuwa-e2e.lock)
#   KASUWA_E2E_LOCK_TIMEOUT  seconds to wait for it (default: 3600)
#
# A lock is stale only when its owner pid is dead, never by age. Never remove a lock you
# did not create.
#
# Exit codes: 3 Docker is not running; 4 the wait for the lock timed out; anything else
# is the e2e command's own status.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="${KASUWA_E2E_LOCK_DIR:-${TMPDIR:-/tmp}/kasuwa-e2e.lock}"
timeout_s="${KASUWA_E2E_LOCK_TIMEOUT:-3600}"
held=0

alive() { kill -0 "$1" 2>/dev/null; }

release() {
  # Only the owner releases, and only a lock that still names this process.
  if [ "$held" = 1 ] && [ "$(cat "$lock/owner.pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$lock"
  fi
  held=0
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

take() {
  mkdir -p "$(dirname "$lock")"
  if mkdir "$lock" 2>/dev/null; then
    echo "$$" > "$lock/owner.pid"
    held=1
    return 0
  fi
  return 1
}

waited=0
until take; do
  owner="$(cat "$lock/owner.pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! alive "$owner"; then
    # The owner is gone. Remove its lock only if it is still that same lock.
    if [ "$(cat "$lock/owner.pid" 2>/dev/null)" = "$owner" ]; then
      rm -rf "$lock"
    fi
    continue
  fi
  if [ "$waited" -ge "$timeout_s" ]; then
    echo "e2e-locked: still held by pid ${owner:-unknown} after ${timeout_s}s ($lock); not starting." >&2
    exit 4
  fi
  sleep 1
  waited=$((waited + 1))
done

if ! docker info >/dev/null 2>&1; then
  echo "e2e-locked: Docker is not running. Start it and try again; this script does not start Docker." >&2
  exit 3
fi

cd "$repo_root" || exit 1
pnpm test:e2e -- "$@"
