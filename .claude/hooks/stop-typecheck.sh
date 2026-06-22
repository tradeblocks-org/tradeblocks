#!/usr/bin/env bash
#
# Stop hook — incremental typecheck gate.
#
# Stop fires every time the main agent finishes a turn, so this stays cheap: it
# runs `tsc --noEmit` (whole-program, but tsconfig has "incremental": true so
# the .tsbuildinfo cache keeps it fast) ONLY when a TypeScript file changed vs
# HEAD. On type errors it blocks and asks Claude to fix.
#
# LOOP GUARD (belt and suspenders): two guards — (1) honor `stop_hook_active`
# if the runtime sets it; (2) a marker file that allows at most 2 CONSECUTIVE
# blocks, then yields so a human can step in. The marker clears on a passing run.
set -uo pipefail

INPUT=$(cat)
DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$DIR" ] || exit 0
cd "$DIR" || exit 0

ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

MARK="$DIR/.git/.claude-stop-typecheck-blocks"

CHANGED=$(
  {
    git diff --name-only --diff-filter=ACMR HEAD -- '*.ts' '*.tsx'
    git diff --cached --name-only --diff-filter=ACMR HEAD -- '*.ts' '*.tsx'
    git ls-files --others --exclude-standard -- '*.ts' '*.tsx'
  } 2>/dev/null | sort -u
)
if [ -z "$CHANGED" ]; then
  rm -f "$MARK"
  exit 0
fi

if npm run -s typecheck >/tmp/tradeblocks-stop-typecheck.log 2>&1; then
  rm -f "$MARK"
  exit 0
fi

COUNT=$(cat "$MARK" 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" >"$MARK"
if [ "$COUNT" -ge 2 ]; then
  rm -f "$MARK"
  exit 0
fi

CTX=$(tail -30 /tmp/tradeblocks-stop-typecheck.log | jq -Rs .)
cat <<EOF
{"decision":"block","reason":"tsc --noEmit found type errors in changed files. Fix them before finishing — run \`npm run typecheck\` to see all of them.","hookSpecificOutput":{"hookEventName":"Stop","additionalContext":$CTX}}
EOF
exit 0
