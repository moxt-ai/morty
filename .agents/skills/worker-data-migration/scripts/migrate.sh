#!/usr/bin/env bash
# Deploy a temporary edge helper that runs the Platform cloud-retention data
# migration against one deployed environment, drain it in batches, verify
# completion from D1, and delete the helper.
#
# Usage: migrate.sh <staging|production>
set -euo pipefail

environment="${1:?usage: migrate.sh <staging|production>}"
case "$environment" in
    staging) worker_name="mobius-platform-staging" ;;
    production) worker_name="mobius-platform-production" ;;
    *) echo "Invalid environment: $environment" >&2; exit 64 ;;
esac

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
repository="${MOBIUS_REPOSITORY:-$(cd -- "$skill_dir/../.." && pwd -P)/third-party/mobius}"
account_id="${CLOUDFLARE_ACCOUNT_ID:-95af7a3d67be8c49b1619544e3ce53c0}"
helper_name="pr2-cloud-retention-migrator-$environment"
helper_script="$skill_dir/scripts/migrator-worker.ts"

if [[ ! -d "$repository/packages/relay-cloudflare-platform" ]]; then
    echo "Mobius checkout not found at $repository; set MOBIUS_REPOSITORY" >&2
    exit 1
fi

config_file="$repository/packages/relay-cloudflare-platform/wrangler.jsonc"
read_value() {
    # Print the first <key>: "<value>" whose line is inside the target env block.
    python3 - "$config_file" "$environment" "$1" <<'PY'
import json, re, sys
raw = open(sys.argv[1]).read()
raw = re.sub(r"//[^\n]*", "", raw)
document = json.loads(raw)
env = document["env"][sys.argv[2]]
key = sys.argv[3]
if key in ("database_name", "database_id"):
    entry = env["d1_databases"][0]
    print(entry[key])
else:
    print(env[key])
PY
}

database_name="$(read_value database_name)"
database_id="$(read_value database_id)"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/worker-data-migration.XXXXXX")"
trap 'rm -rf "$work_dir"; delete_helper' EXIT

delete_helper() {
    if [[ -n "${helper_deployed:-}" ]]; then
        CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" delete "$helper_name" 2>/dev/null || true
    fi
}

# Resolve the pinned Wrangler from the Mobius checkout without a global install.
wrangler="$(find "$repository/node_modules/.pnpm" -maxdepth 6 -path '*wrangler@*/node_modules/wrangler/bin/wrangler.js' 2>/dev/null | sort -V | tail -n 1)"
if [[ -z "$wrangler" ]]; then
    echo "Wrangler not found under $repository/node_modules; run pnpm install there" >&2
    exit 1
fi

token="$(openssl rand -hex 32)"
printf '%s' "$token" > "$work_dir/token.txt"
chmod 600 "$work_dir/token.txt"
python3 -c 'import json,sys; json.dump({"HELPER_TOKEN": sys.argv[2]}, open(sys.argv[1], "w"))' \
    "$work_dir/secrets.json" "$token"
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
            { "name": "PROJECT_RELAY", "class_name": "ProjectRelay", "script_name": "$worker_name" }
        ]
    },
    "d1_databases": [
        { "binding": "PLATFORM_DIRECTORY_DATABASE", "database_name": "$database_name", "database_id": "$database_id" }
    ]
}
JSONC

echo "Deploying temporary helper for $environment..."
CLOUDFLARE_ACCOUNT_ID="$account_id" node "$wrangler" deploy \
    --config "$work_dir/wrangler.jsonc" --secrets-file "$work_dir/secrets.json" >/dev/null
helper_deployed=1
base="https://$helper_name.paraflow.workers.dev"

call() {
    curl --fail --silent --show-error --max-time 300 -H "x-helper-token: $token" "$@"
}

echo "Status before: $(call "$base/status")"
while :; do
    result="$(call -X POST "$base/migrate-batch?limit=10")"
    echo "  $result"
    remaining="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["remainingProjects"])' <<<"$result")"
    if [[ "$remaining" == "0" ]]; then
        break
    fi
done

total="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["totalProjects"])' <<<"$(call "$base/status")")"
completed="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["completedProjects"])' <<<"$(call "$base/status")")"
echo "$environment: total=$total migrated=$completed remaining=$((total - completed))"
if [[ "$completed" != "$total" ]]; then
    echo "Migration incomplete for $environment" >&2
    exit 1
fi
