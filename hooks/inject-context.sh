#!/bin/bash
# UserPromptSubmit Hook: Inject relevant past decisions into the conversation context.
#
# Claude Code passes hook input as JSON on stdin:
#   { "session_id": "...", "cwd": "...", "prompt": "...", ... }
# The actual user prompt must be parsed from the "prompt" field — using the
# raw stdin blob would search memory with JSON wrapping noise.
#
# Plain-text stdin (manual invocation) is still accepted as the prompt itself.

set -euo pipefail

# Read raw stdin
RAW_INPUT=""
if [ ! -t 0 ]; then
  RAW_INPUT=$(cat 2>/dev/null || true)
fi

if [[ -z "$RAW_INPUT" ]]; then
  exit 0
fi

# Parse JSON fields (prompt, cwd); fall back to raw text / env for manual runs
PARSED=$(node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(data);
    process.stdout.write(JSON.stringify({ prompt: j.prompt || "", cwd: j.cwd || "" }));
  } catch {
    process.stdout.write(JSON.stringify({ prompt: data, cwd: "" }));
  }
});' <<< "$RAW_INPUT" 2>/dev/null || echo '{"prompt":"","cwd":""}')

USER_PROMPT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).prompt)' "$PARSED" 2>/dev/null || true)
JSON_CWD=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).cwd)' "$PARSED" 2>/dev/null || true)

CWD="${JSON_CWD:-${CWD:-$(pwd)}}"

if [[ -z "$USER_PROMPT" ]]; then
  exit 0
fi

# Minimum prompt length to avoid wasting tokens on short inputs
if [[ ${#USER_PROMPT} -lt 20 ]]; then
  exit 0
fi

# Locate inject script
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INJECT_SCRIPT="${HOOK_DIR}/../scripts/inject-context.js"

if [[ ! -f "$INJECT_SCRIPT" ]]; then
  exit 0
fi

# Run the Node.js injection script
# It reads USER_PROMPT from env, writes context to stdout
CONTEXT=$(CWD="$CWD" USER_PROMPT="$USER_PROMPT" node "$INJECT_SCRIPT" 2>/dev/null || true)

if [[ -n "$CONTEXT" ]]; then
  # Output the context block; Claude Code will prepend it to the user prompt
  printf '%s\n\n' "$CONTEXT"
fi

exit 0
