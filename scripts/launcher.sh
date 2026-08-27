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
[ -f "$tmp/project/.colors/temporal-fixture/temporal-infrastructure/main.tf" ] || fail 'render missing'
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
echo "launcher: $checks checks passed"
