#!/usr/bin/env bash
# Lead verification (D-L111): gates, the tenancy folder, the PR's own suites and e2e tags, run one
# at a time under the RAM-slot lock that builders also honour (D-L118: at most two heavy jobs).
#
#   tools/lead-verify.sh <worktree> <log> [--files a,b,c] [--tags @x,@y] [--full]
#
# --full runs the whole isolation suite instead of the tenancy folder (end of Phase 2 only).
# Slots live in $KASUWA_SLOTS (default ~/.kasuwa-slots): node-slot-1, node-slot-2, each holding
# owner.pid. A slot is stale only when its owner pid is dead, never by age. Never remove a slot
# you did not create.
set -uo pipefail

worktree="$1"; log="$2"; shift 2
files=""; tags=""; full=0
while [ $# -gt 0 ]; do
  case "$1" in
    --files) files="$2"; shift 2 ;;
    --tags) tags="$2"; shift 2 ;;
    --full) full=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

slots="${KASUWA_SLOTS:-$HOME/.kasuwa-slots}"
mkdir -p "$slots"
held=""

alive() { kill -0 "$1" 2>/dev/null; }

take_slot() {
  while true; do
    if [ ! -d "$slots/lead-exclusive-wait" ]; then
      for n in 1 2; do
        d="$slots/node-slot-$n"
        if [ -d "$d" ]; then
          owner="$(cat "$d/owner.pid" 2>/dev/null || echo 0)"
          if [ "$owner" != "0" ] && ! alive "$owner"; then rm -rf "$d"; fi
        fi
        if mkdir "$d" 2>/dev/null; then echo $$ > "$d/owner.pid"; held="$d"; return; fi
      done
    fi
    sleep 30
  done
}

release() { [ -n "$held" ] && rm -rf "$held"; }
trap release EXIT

take_slot
cd "$worktree" || exit 2
echo "== slot $held $(date -u +%FT%TZ)" > "$log"
run() { local name="$1"; shift; "$@" >> "$log" 2>&1; echo "== $name exit $?" >> "$log"; }

run install pnpm -s install --frozen-lockfile
run lint npx nx run-many -t lint --parallel=1
run typecheck npx nx run-many -t typecheck --parallel=1
run unit pnpm run -s test:unit
run integration pnpm run -s test:integration
if [ "$full" = 1 ]; then
  run isolation pnpm run -s test:isolation
else
  run "isolation tenancy" npx vitest run --project isolation tests/acceptance/tenancy
fi
IFS=',' read -ra list <<< "$files"
for f in "${list[@]}"; do [ -n "$f" ] && run "isolation $f" npx vitest run --project isolation "$f"; done
IFS=',' read -ra tlist <<< "$tags"
for t in "${tlist[@]}"; do [ -n "$t" ] && run "e2e $t" node tests/e2e/scripts/run-e2e.mjs --grep "$t"; done
echo "== done $(date -u +%FT%TZ)" >> "$log"
grep -E '^== |Tests +[0-9]|FAIL ' "$log" | grep -v '^ *✓' | head -80
