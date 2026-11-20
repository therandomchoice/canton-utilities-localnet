#!/usr/bin/env bash
# Upgrade the localnet to another Splice release by 3-way merging upstream changes.
#
# Upstream: https://github.com/hyperledger-labs/splice, path cluster/compose/localnet
# (identical to /app/splice-node/docker-compose/localnet inside the splice-app image).
#
#   vendor/splice-localnet/  pristine upstream snapshot at the ref in vendor/splice.ref
#   modules/localnet/        our working copy (upstream + Utilities additions, see README.md)
#
# For every upstream file: git merge-file ours=modules/localnet base=old snapshot theirs=new upstream.
#   - changed upstream, untouched locally  -> takes upstream version
#   - changed on both sides                -> merged, or conflict markers left in the file
#   - new upstream file                    -> copied into modules/localnet
#   - removed upstream                     -> reported only (delete it yourself if appropriate)
#   - present in old snapshot but not ours -> skipped (we removed it on purpose)
# Then the snapshot, vendor/splice.ref and IMAGE_TAG in the Makefile are updated.
#
# Usage: tools/vendor-splice.sh <splice-tag>     e.g. tools/vendor-splice.sh 0.10.4
set -euo pipefail

tag="${1:?usage: $0 <splice-tag>}"
repo="https://github.com/hyperledger-labs/splice.git"
src_path="cluster/compose/localnet"

root="$(cd "$(dirname "$0")/.." && pwd)"
ours="$root/modules/localnet"
base="$root/vendor/splice-localnet"
ref_file="$root/vendor/splice.ref"

[ -d "$base" ] && [ -f "$ref_file" ] || { echo "missing $base or $ref_file" >&2; exit 1; }
old_tag=$(awk '{print $1}' "$ref_file")
if [ "$old_tag" = "$tag" ]; then
  echo "already on splice $tag"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "fetching $repo $tag ($src_path)"
git clone -q --filter=blob:none --no-checkout --depth 1 --branch "$tag" "$repo" "$tmp/splice"
git -C "$tmp/splice" sparse-checkout set --no-cone "$src_path"
git -C "$tmp/splice" checkout -q "$tag"
commit=$(git -C "$tmp/splice" rev-parse HEAD)
theirs="$tmp/splice/$src_path"
[ -d "$theirs" ] || { echo "$src_path not found in $tag" >&2; exit 1; }

conflicts=()
updated=()
added=()
removed=()

while IFS= read -r -d '' f; do
  rel="${f#"$theirs"/}"
  if [ ! -e "$base/$rel" ]; then
    if [ -e "$ours/$rel" ]; then
      conflicts+=("$rel (new upstream, but a local file already exists; upstream copy: $rel.upstream)")
      cp -p "$f" "$ours/$rel.upstream"
    else
      mkdir -p "$(dirname "$ours/$rel")"
      cp -p "$f" "$ours/$rel"
      added+=("$rel")
    fi
    continue
  fi
  [ -e "$ours/$rel" ] || continue                 # removed locally on purpose
  cmp -s "$base/$rel" "$f" && continue             # unchanged upstream
  if git merge-file -q -L "local" -L "splice $old_tag" -L "splice $tag" "$ours/$rel" "$base/$rel" "$f"; then
    updated+=("$rel")
  else
    conflicts+=("$rel")
  fi
done < <(find "$theirs" -type f -print0 | sort -z)

while IFS= read -r -d '' f; do
  rel="${f#"$base"/}"
  [ -e "$theirs/$rel" ] || removed+=("$rel")
done < <(find "$base" -type f -print0 | sort -z)

# Advance the pristine snapshot, ref and image tag
rm -rf "$base"
cp -rp "$theirs" "$base"
echo "$tag $commit" > "$ref_file"
sed -i -E "s/^(IMAGE_TAG[[:space:]]*:=[[:space:]]*).*/\1$tag/" "$root/Makefile"

print_list() {
  local title="$1"; shift
  [ "$#" -gt 0 ] || return 0
  echo "$title"
  printf '  %s\n' "$@"
}
echo
echo "splice $old_tag -> $tag ($commit)"
print_list "updated:" "${updated[@]}"
print_list "added:" "${added[@]}"
print_list "removed upstream (review, not deleted locally):" "${removed[@]}"
if [ "${#conflicts[@]}" -gt 0 ]; then
  print_list "CONFLICTS (resolve the <<<<<<< markers / .upstream files):" "${conflicts[@]}"
  exit 1
fi
echo "no conflicts. Review with: git diff -- modules/localnet Makefile"
