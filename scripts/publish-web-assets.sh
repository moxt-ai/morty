#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  staging)
    bucket="morty-staging-web-assets"
    app_origin="https://morty.paradev.biz"
    asset_origin="https://assets.morty.paradev.biz"
    ;;
  production)
    bucket="morty-production-web-assets"
    app_origin="https://morty.build"
    asset_origin="https://assets.morty.build"
    ;;
  *)
    echo "Expected staging or production" >&2
    exit 1
    ;;
esac

asset_directory="dist/client/assets"
if [[ ! -d "$asset_directory" ]]; then
  echo "Missing built web assets: $asset_directory" >&2
  exit 1
fi

assets=()
while IFS= read -r -d '' file; do
  assets+=("$file")
done < <(find "$asset_directory" -type f ! -name '*.map' -print0)
if [[ "${#assets[@]}" -eq 0 ]]; then
  echo "No web assets were built" >&2
  exit 1
fi

manifest_directory="$(mktemp -d)"
headers="$(mktemp)"
trap 'rm -rf "$manifest_directory"; rm -f "$headers"' EXIT
javascript_manifest="$manifest_directory/javascript.json"
css_manifest="$manifest_directory/css.json"
ttf_manifest="$manifest_directory/ttf.json"
woff_manifest="$manifest_directory/woff.json"
woff2_manifest="$manifest_directory/woff2.json"
printf '[]\n' > "$javascript_manifest"
printf '[]\n' > "$css_manifest"
printf '[]\n' > "$ttf_manifest"
printf '[]\n' > "$woff_manifest"
printf '[]\n' > "$woff2_manifest"

javascript_entries=()
css_entries=()
ttf_entries=()
woff_entries=()
woff2_entries=()
for file in "${assets[@]}"; do
  key="${file#dist/client/}"
  if [[ ! "$key" =~ ^assets/[A-Za-z0-9._-]+\.(css|js|ttf|woff|woff2)$ ]]; then
    echo "Unsafe or unsupported web asset path: $key" >&2
    exit 1
  fi
  entry="{\"key\":\"$key\",\"file\":\"$file\"}"
  case "$file" in
    *.css)
      css_entries+=("$entry")
      ;;
    *.js)
      javascript_entries+=("$entry")
      ;;
    *.ttf)
      ttf_entries+=("$entry")
      ;;
    *.woff)
      woff_entries+=("$entry")
      ;;
    *.woff2)
      woff2_entries+=("$entry")
      ;;
  esac
done

write_manifest() {
  local manifest="$1"
  shift
  printf '%s\n' "$(IFS=,; printf '[%s]' "$*")" > "$manifest"
}
write_manifest "$javascript_manifest" "${javascript_entries[@]}"
write_manifest "$css_manifest" "${css_entries[@]}"
write_manifest "$ttf_manifest" "${ttf_entries[@]}"
write_manifest "$woff_manifest" "${woff_entries[@]}"
write_manifest "$woff2_manifest" "${woff2_entries[@]}"

if ! pnpm exec wrangler r2 bucket info "$bucket" --json >/dev/null; then
  echo "Web asset bucket is unavailable: $bucket" >&2
  echo "Provision it and its CDN domain and CORS policy as documented in DEVELOPMENT.md." >&2
  exit 1
fi

publish_assets() {
  local manifest="$1"
  local content_type="$2"
  local count="$3"
  if [[ "$count" -eq 0 ]]; then
    return
  fi
  # The pinned bulk command reuses one authenticated Wrangler process while
  # separate manifests preserve each asset type's content type.
  pnpm exec wrangler r2 bulk put "$bucket" \
    --filename "$manifest" \
    --content-type "$content_type" \
    --cache-control "public, max-age=31536000, immutable" \
    --concurrency 20 \
    --remote \
    --force
}
publish_assets "$javascript_manifest" "text/javascript; charset=utf-8" "${#javascript_entries[@]}"
publish_assets "$css_manifest" "text/css; charset=utf-8" "${#css_entries[@]}"
publish_assets "$ttf_manifest" "font/ttf" "${#ttf_entries[@]}"
publish_assets "$woff_manifest" "font/woff" "${#woff_entries[@]}"
publish_assets "$woff2_manifest" "font/woff2" "${#woff2_entries[@]}"

probe_key="${assets[0]#dist/client/}"
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  --header "Origin: $app_origin" \
  --dump-header "$headers" \
  --output /dev/null \
  "$asset_origin/$probe_key"
if ! grep -Fqi "access-control-allow-origin: $app_origin" "$headers"; then
  echo "Asset CDN did not authorize $app_origin" >&2
  exit 1
fi
if ! grep -Fqi 'cache-control: public, max-age=31536000, immutable' "$headers"; then
  echo "Asset CDN did not preserve immutable caching" >&2
  exit 1
fi
