#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-temporal-green/green"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail(){ echo "launcher: FAIL — $*" >&2; exit 1; }
ok(){ checks=$((checks+1)); echo "  ok — $*"; }

grep -q 'io.github.getcolors.temporal.workflow/workflow' "$launcher" || fail 'no workflow dispatch'
grep -q 'io.github.getcolors.temporal.operator/run' "$launcher" || fail 'no acceptance dispatch'
ok 'dispatches to library workflow and operator'
for bad in 'defn.*-step' 'tofu/' 'ansible/'; do ! grep -qE "$bad" "$launcher" || fail "launcher contains $bad logic"; done
ok 'contains no tool logic'
grep -qE '\(def \^:private temporal-sha (nil|"[0-9a-f]{40}")\)' "$launcher" || fail 'invalid pin site'
ok 'has one managed pin site'
[[ -L "$root/green/green" && $(readlink "$root/green/green") == ../skills/package-temporal-green/green ]] || fail 'green/green is not the payload symlink'
[[ -L "$root/red/red" && $(readlink "$root/red/red") == ../skills/package-temporal-red/red ]] || fail 'red/red is not the payload symlink'
[[ -L "$root/blue/blue" && $(readlink "$root/blue/blue") == ../skills/package-temporal-blue/blue ]] || fail 'blue/blue is not the payload symlink'
ok 'each colour dir symlinks its skill payload'

mkdir "$tmp/project"; cp "$launcher" "$tmp/project/green"; chmod +x "$tmp/project/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/project/colors.yml"
(cd "$tmp/project" && TEMPORAL_LIB_ROOT="$root" ./green build >/dev/null) || fail 'working-tree override failed'
[ -f "$tmp/project/.colors/temporal-fixture/compute/shared/backend.tf.json" ] || fail 'render missing'
[ -f "$tmp/project/.colors/temporal-fixture/temporal-ansible/application/src/workflows.ts" ] || fail 'application render missing'
ok 'working-tree override renders from a copied payload'
mkdir -p "$tmp/project/deep/path"
(cd "$tmp/project/deep/path" && TEMPORAL_LIB_ROOT="$root" ../../green build >/dev/null) || fail 'upward colors.yml search failed'
ok 'finds desired state by walking upward'
# The profile guard is the whole reason COLORS_PAR_PROFILE is refused: an
# overlay would point one deployment at another's state.
out=$(cd "$tmp/project" && TEMPORAL_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out" || fail 'profile overlay was not refused'
[[ ! -d "$tmp/project/.colors/wrong" ]] || fail 'profile overlay rendered a tree'
ok 'refuses the profile overlay'
out=$(cd "$tmp/project" && TEMPORAL_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'unknown verb has no usage'
ok 'unknown verb prints usage'
for verb in build create delete acceptance; do grep -q "\"$verb\"" "$launcher" || fail "missing verb $verb"; done
ok 'all lifecycle verbs are dispatchable'

# --- red -------------------------------------------------------------------
# The red payload resolves colors-compute at the commit green's deps.edn pins,
# through red/package.json and the root manifest a copied payload installs.
red_launcher="$root/skills/package-temporal-red/red"
[ -f "$red_launcher" ] || fail 'red payload launcher is missing'
compute_sha=$(awk '/colors-compute\.git/ {found=1} found && match($0, /:git\/sha "[0-9a-f]{40}"/) {print substr($0, RSTART+10, 40); exit}' "$root/green/deps.edn")
[[ -n $compute_sha ]] || fail 'green/deps.edn carries no colors-compute pin'
grep -q "getcolors/colors-compute#$compute_sha" "$root/red/package.json" || fail 'red/package.json pins colors-compute at a different commit than green'
grep -q "getcolors/colors-compute#$compute_sha" "$root/package.json" || fail 'the root package.json pins colors-compute at a different commit than green'
ok 'every red record of the colors-compute pin matches green'

# colors-compute-red declares the Red SDK as a peer, so a cold launcher cache
# installs the SDK only because PINS names it. The pin must be the one
# red/package.json tests against, and a cold cache must actually resolve it:
# the working-tree builds reuse red/node_modules and cannot see a missing peer.
red_sdk_sha=$(grep -oE '"red": "github:getcolors/red#[0-9a-f]{40}"' "$root/red/package.json" | grep -oE '[0-9a-f]{40}')
[[ -n $red_sdk_sha ]] || fail 'red/package.json carries no Red SDK pin'
grep -q "\"red\": \"github:getcolors/red#$red_sdk_sha\"" "$red_launcher" || fail 'red payload PINS the Red SDK at a different commit than red/package.json'
ok 'the red payload PINS the Red SDK at the red/package.json commit'
mkdir "$tmp/red-cold"
cp "$red_launcher" "$tmp/red-cold/red"; chmod +x "$tmp/red-cold/red"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/red-cold/colors.yml"
# One retry: a cold install fetches GitHub tarballs and a transient fetch
# failure is not a payload defect. Each attempt starts from empty caches.
cold_ok=0
for attempt in 1 2; do
  rm -rf "$tmp/red-cold/xdg" "$tmp/red-cold/bun" "$tmp/red-cold/.colors"
  if (cd "$tmp/red-cold" && XDG_CACHE_HOME="$tmp/red-cold/xdg" BUN_INSTALL_CACHE_DIR="$tmp/red-cold/bun" ./red build >"$tmp/red-cold/build.log" 2>&1); then cold_ok=1; break; fi
done
[[ $cold_ok == 1 ]] || { tail -5 "$tmp/red-cold/build.log" >&2; fail 'red payload does not build from a cold cache'; }
[ -f "$tmp/red-cold/.colors/temporal-fixture/compute/shared/backend.tf.json" ] || fail 'cold red payload rendered nothing'
ok 'red payload builds from a cold cache with only its PINS'
echo "launcher: $checks checks passed"
