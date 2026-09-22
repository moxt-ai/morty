#!/usr/bin/env bash
# Repair the incident's scrubbed non-cloud-retention Turn in a deployed Platform
# environment. Deploys a token-gated helper that calls the one-shot DO repair
# operation, verifies readability through the production `turn` read path, and
# deletes the helper on exit.
#
# Usage: repair-turn.sh <staging|production> <projectId> <runtimeId> <sessionId> <commandId> <turnId>
#
# The target Platform Worker must be a temporary repair build that contains the
# token-gated repair-scrubbed-turn operation. This script installs the matching
# temporary secret and removes it again during cleanup.
set -euo pipefail

environment="${1:?usage: repair-turn.sh <staging|production> <projectId> <runtimeId> <sessionId> <commandId> <turnId>}"
project_id="${2:?projectId}"
runtime_id="${3:?runtimeId}"
session_id="${4:?sessionId}"
command_id="${5:?commandId}"
turn_id="${6:?turnId}"
case "$environment" in
    staging) worker_name="mobius-platform-staging" ;;
    production) worker_name="mobius-platform-production" ;;
    *) echo "Invalid environment: $environment" >&2; exit 64 ;;
esac

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
repository="${MOBIUS_REPOSITORY:-$(cd -- "$skill_dir/../.." && pwd -P)/third-party/mobius}"
account_id="${CLOUDFLARE_ACCOUNT_ID:-95af7a3d67be8c49b1619544e3ce53c0}"
helper_name="turn-repair-helper-$environment"
helper_script="$skill_dir/scripts/turn-repair-worker.ts"

if [[ ! -d "$repository/packages/relay-cloudflare-platform" ]]; then
    echo "Mobius checkout not found at $repository; set MOBIUS_REPOSITORY" >&2
    exit 1
fi

wrangler="$(find "$repository/node_modules/.pnpm" -maxdepth 6 -path '*wrangler@*/node_modules/wrangler/bin/wrangler.js' 2>/dev/null | sort -V | tail -n 1)"
if [[ -z "$wrangler" ]]; then
    echo "Wrangler not found under $repository/node_modules; run pnpm install there" >&2
    exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/turn-repair.XXXXXX")"
helper_deployed=""
secret_configured=""
delete_helper() {
    if [[ -n "$helper_deployed" ]]; then
        CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" delete "$helper_name" >/dev/null 2>&1 || true
    fi
    if [[ -n "$secret_configured" ]]; then
        CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" secret delete \
            NON_CLOUD_RETENTION_TURN_REPAIR_TOKEN --name "$worker_name" --force >/dev/null 2>&1 || true
    fi
    rm -rf "$work_dir"
}
trap delete_helper EXIT

helper_token="$(openssl rand -hex 32)"
repair_token="$(openssl rand -hex 32)"
printf '%s' "$helper_token" > "$work_dir/helper-token.txt"
printf '%s' "$repair_token" > "$work_dir/repair-token.txt"
chmod 600 "$work_dir/helper-token.txt" "$work_dir/repair-token.txt"
python3 - "$work_dir/secrets.json" "$helper_token" <<'PY'
import json, sys
json.dump({"HELPER_TOKEN": sys.argv[2]}, open(sys.argv[1], "w"))
PY
chmod 600 "$work_dir/secrets.json"

cat > "$work_dir/wrangler.jsonc" <<JSONC
{
    "\$schema": "$repository/node_modules/wrangler/config-schema.json",
    "name": "$helper_name",
    "main": "$helper_script",
    "compatibility_date": "2026-09-03",
    "workers_dev": true,
    "durable_objects": {
        "bindings": [
            { "name": "NON_CLOUD_RETENTION_SESSION_RELAY", "class_name": "NonCloudRetentionSessionRelayDO", "script_name": "$worker_name" }
        ]
    }
}
JSONC

echo "Deploying temporary helper for $environment..."
CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" deploy \
    --config "$work_dir/wrangler.jsonc" --secrets-file "$work_dir/secrets.json" >/dev/null
helper_deployed=1
printf '%s' "$repair_token" | CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" secret put \
    NON_CLOUD_RETENTION_TURN_REPAIR_TOKEN --name "$worker_name" >/dev/null
secret_configured=1
base="https://$helper_name.paraflow.workers.dev"

call() {
    curl --fail --silent --show-error --max-time 120 -H "x-helper-token: $helper_token" "$@"
}

echo "Reading the Turn through the production path (expect failure before repair)..."
call -X POST "$base/read-turn" --data "$(python3 -c 'import json,sys; print(json.dumps({"projectId": sys.argv[1], "runtimeId": sys.argv[2], "sessionId": sys.argv[3], "turnId": sys.argv[4]}))' "$project_id" "$runtime_id" "$session_id" "$turn_id")" || echo "  (pre-repair read failed as expected)"

echo "Applying the one-shot repair..."
repair_result="$(call -X POST "$base/repair-turn" --data "$(python3 -c 'import json,sys; print(json.dumps({"projectId": sys.argv[1], "runtimeId": sys.argv[2], "sessionId": sys.argv[3], "commandId": sys.argv[4], "repairToken": sys.argv[5]}))' "$project_id" "$runtime_id" "$session_id" "$command_id" "$repair_token")")"
echo "  $repair_result"

echo "Reading the Turn through the production path (expect success after repair)..."
read_result="$(call -X POST "$base/read-turn" --data "$(python3 -c 'import json,sys; print(json.dumps({"projectId": sys.argv[1], "runtimeId": sys.argv[2], "sessionId": sys.argv[3], "turnId": sys.argv[4]}))' "$project_id" "$runtime_id" "$session_id" "$turn_id")")"
echo "  $read_result"

python3 - "$repair_result" "$read_result" <<'PY'
import json, sys
repair = json.loads(sys.argv[1])
read = json.loads(sys.argv[2])
result = repair.get("result") or {}
if repair.get("status") != 200 or not result.get("readable"):
    print("Repair did not produce a readable Turn", file=sys.stderr)
    sys.exit(1)
read_result = read.get("result") or {}
if read.get("status") != 200:
    print("Post-repair production read failed", file=sys.stderr)
    sys.exit(1)
request = read_result.get("request") or {}
if request.get("content") != "[Content unavailable]":
    print("Post-repair prompt is not the redaction placeholder", file=sys.stderr)
    sys.exit(1)
print("Repair verified: readable, redacted.")
PY
