#!/usr/bin/env bash
# Collect the OpenAPI specs shown in Swagger UI (http://localhost:9090) into openapi/:
#
#   openapi/splice/     Validator API and Wallet API, from hyperledger-labs/splice at the tag in
#                       vendor/splice.ref (the splice-app image doesn't ship them). The directory tree
#                       of the repository is kept, because the specs reference each other by
#                       relative paths (../../../../common/src/main/openapi/...).
#   openapi/utilities/  Utilities API and Token Standard registry API (v1, v2), from /app/backend.jar
#                       of the hosted-backend image (UTILITIES_BACKEND_VERSION in compose.env).
#
# Every spec gets `servers` pointing at the localnet (one entry per validator), so "Try it out"
# calls the right host. The wallet spec declares no security scheme; a bearer scheme is added so
# that Swagger UI can send the user's JWT.
#
# Usage: tools/openapi.sh      (or make openapi)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/openapi"
splice_tag=$(awk '{print $1}' "$root/vendor/splice.ref")
env_file="$root/modules/localnet/compose.env"
backend_version=$(sed -nE 's/^UTILITIES_BACKEND_VERSION=\$\{UTILITIES_BACKEND_VERSION:-(.*)\}$/\1/p' "$env_file")
image_repo=$(sed -nE 's/^UTILITIES_IMAGE_REPO=\$\{UTILITIES_IMAGE_REPO:-(.*)\}$/\1/p' "$env_file")
backend_image="${image_repo}/hosted-backend:${backend_version}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Replace the top-level `servers:` block with the given URLs ("url|description" per argument)
set_servers() {
  local file="$1"; shift
  local block="servers:"
  for s in "$@"; do block+=$'\n'"  - url: ${s%%|*}"$'\n'"    description: ${s#*|}"; done
  awk -v block="$block" '
    /^servers:/ { print block; skip = 1; next }
    skip && /^[^ \t-]/ { skip = 0 }
    !skip { print }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

# Add a global bearer security requirement (and the scheme) to a spec that has none
add_bearer_auth() {
  local file="$1"
  grep -q '^security:' "$file" && return 0
  awk '
    /^paths:/ && !sec { print "security:\n  - userAuth: []"; sec = 1 }
    { print }
    /^components:/ && !schemes {
      print "  securitySchemes:\n    userAuth:\n      description: HS256 JWT of the wallet user (sub = app-provider, app-user or sv; secret \"unsafe\")\n      type: http\n      scheme: bearer\n      bearerFormat: JWT"
      schemes = 1
    }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

validators=(
  "http://wallet.localhost:3000/api/validator|app-provider validator"
  "http://wallet.localhost:2000/api/validator|app-user validator"
  "http://wallet.localhost:4000/api/validator|sv validator"
)
utilities=(
  "http://utility.localhost:3000|operator's hosted-backend via app-provider nginx"
  "http://utility.localhost:2000|operator's hosted-backend via app-user nginx"
  "http://utility.localhost:4000|operator's hosted-backend via sv nginx"
)

rm -rf "$out/splice" "$out/utilities"

# Splice: validator and wallet specs plus the common specs they reference
echo "openapi: fetching hyperledger-labs/splice ${splice_tag}"
git clone -q --filter=blob:none --no-checkout --depth 1 --branch "$splice_tag" \
  https://github.com/hyperledger-labs/splice.git "$tmp/splice"
splice_files=(
  apps/common/src/main/openapi/common-external.yaml
  apps/common/src/main/openapi/common-internal.yaml
  apps/validator/src/main/openapi/validator-internal.yaml
  apps/wallet/src/main/openapi/wallet-internal.yaml
)
git -C "$tmp/splice" sparse-checkout set --no-cone "${splice_files[@]}"
git -C "$tmp/splice" checkout -q "$splice_tag"
for f in "${splice_files[@]}"; do
  mkdir -p "$out/splice/$(dirname "$f")"
  cp "$tmp/splice/$f" "$out/splice/$f"
done
set_servers "$out/splice/apps/validator/src/main/openapi/validator-internal.yaml" "${validators[@]}"
set_servers "$out/splice/apps/wallet/src/main/openapi/wallet-internal.yaml" "${validators[@]}"
add_bearer_auth "$out/splice/apps/wallet/src/main/openapi/wallet-internal.yaml"

# Utilities: specs inside the hosted-backend jar
echo "openapi: extracting specs from ${backend_image}"
cid=$(docker create "$backend_image")
docker cp -q "$cid:/app/backend.jar" "$tmp/backend.jar"
docker rm -f "$cid" >/dev/null
mkdir -p "$out/utilities"
unzip -q -o "$tmp/backend.jar" 'utility.yaml' 'utility-token-standard/*.yaml' -d "$out/utilities"
for f in "$out/utilities/utility.yaml" "$out/utilities"/utility-token-standard/v*/*.yaml; do
  set_servers "$f" "${utilities[@]}"
done

echo "openapi: splice ${splice_tag}, hosted-backend ${backend_version}" > "$out/VERSIONS"
find "$out" -name '*.yaml' | sed "s#^$root/##" | sort
