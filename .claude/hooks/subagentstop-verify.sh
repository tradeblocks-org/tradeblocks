#!/usr/bin/env bash
#
# SubagentStop hook — full verification gate for delegated work.
#
# Fires once when a Task subagent finishes (much rarer than Stop), so it can
# afford the comprehensive gate: `npm run verify` = typecheck + lint +
# format:check. If a subagent left the tree broken, block before control
# returns to the main agent.
#
# Skips entirely when the working tree is clean (a read-only subagent changed
# nothing). Same 2-consecutive-block throttle as the Stop hook to bar loops.
set -uo pipefail

INPUT=$(cat)
DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$DIR" ] || exit 0
cd "$DIR" || exit 0

ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0
fi

MARK="$DIR/.git/.claude-subagent-verify-blocks"

if npm run -s verify >/tmp/tradeblocks-subagent-verify.log 2>&1; then
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

CTX=$(tail -40 /tmp/tradeblocks-subagent-verify.log | jq -Rs .)
cat <<EOF
{"decision":"block","reason":"Quality gate failed: \`npm run verify\` (typecheck / lint / format:check) did not pass. Fix before returning control.","hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":$CTX}}
EOF
exit 0
