#!/bin/sh
# TEMP local helper: run setup and print the Continue handoff URL.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${1:-$ROOT/.chat-local-dev}
HARNESS=${2:-claude}
SESSION_ID=${3:-local-dev}

case "$HARNESS" in
    claude)
        if ! command -v claude >/dev/null 2>&1; then
            echo "claude is not on PATH." >&2
            exit 1
        fi
        ;;
    codex)
        if ! command -v codex >/dev/null 2>&1; then
            echo "codex is not on PATH." >&2
            exit 1
        fi
        ;;
    *)
        echo "Unsupported harness: $HARNESS (use claude or codex)" >&2
        exit 1
        ;;
esac

STDOUT_LOG="$STATE_DIR/setup-last-run.stdout"
STDERR_LOG="$STATE_DIR/setup-last-run.stderr"
node "$ROOT/scripts/local-dev.cjs" setup \
    --state-dir "$STATE_DIR" \
    --harness "$HARNESS" \
    --session-id "$SESSION_ID" >"$STDOUT_LOG" 2>"$STDERR_LOG" ||
    {
        cat "$STDERR_LOG" >&2
        exit 1
    }

tail -1 "$STDOUT_LOG" |
    node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
    const line = data.trim();
    if (line.length === 0) {
        console.error("Setup did not print a JSON record on stdout.");
        process.exit(1);
    }
    const record = JSON.parse(line);
    if (typeof record.handoffUrl !== "string" || record.handoffUrl.length === 0) {
        console.error("Setup record did not include handoffUrl:", record);
        process.exit(1);
    }
    process.stdout.write(`${record.handoffUrl}\n`);
});
'
