#!/bin/sh
# TEMP local helper: run Codex setup against a local stack and print the Continue handoff URL.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR=${1:-$ROOT/.chat-local-dev}
SESSION_ID=${2:-local-dev}

if ! command -v codex >/dev/null 2>&1; then
    echo "codex is not on PATH; install Codex CLI or open this script from a shell where codex works." >&2
    exit 1
fi

STDOUT_LOG="$STATE_DIR/setup-last-run.stdout"
STDERR_LOG="$STATE_DIR/setup-last-run.stderr"
node "$ROOT/scripts/local-dev.cjs" setup \
    --state-dir "$STATE_DIR" \
    --harness codex \
    --session-id "$SESSION_ID" >"$STDOUT_LOG" 2>"$STDERR_LOG" ||
    {
        cat "$STDERR_LOG" >&2
        exit 1
    }

tail -1 "$STDOUT_LOG" |
    node -e '
const fs = require("node:fs");
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
