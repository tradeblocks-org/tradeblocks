#!/usr/bin/env bash
#
# PostToolUse(Edit|Write) — format + lint-fix the single file just edited.
#
# Fast, file-scoped, NON-BLOCKING: always exits 0. The edit already happened;
# this is best-effort tidy-up of that one file (the "format on save" pattern).
# The authoritative gates are the Stop/SubagentStop hooks and CI.
set -uo pipefail

INPUT=$(cat)
DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$DIR" ] || exit 0

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

# Only touch files inside this project.
case "$FILE" in
  "$DIR"/*) ;;
  *) exit 0 ;;
esac

cd "$DIR" || exit 0

case "$FILE" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.css | *.md)
    npx prettier --write --log-level warn "$FILE" >/dev/null 2>&1 || true
    ;;
esac

case "$FILE" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs)
    npx eslint --fix "$FILE" >/dev/null 2>&1 || true
    ;;
esac

exit 0
