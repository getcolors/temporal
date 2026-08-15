#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-temporal-green/green"
grep -q 'io.github.getcolors.temporal.workflow/workflow' "$launcher"
grep -q 'io.github.getcolors.temporal.operator/run' "$launcher"
[[ -L "$root/green" ]] && [[ $(readlink "$root/green") == skills/package-temporal-green/green ]]
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "$launcher" "$tmp/green"; chmod +x "$tmp/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/colors.yml"
(cd "$tmp" && TEMPORAL_LIB_ROOT="$root" ./green build >/dev/null)
[[ -f "$tmp/.colors/temporal-fixture/temporal-infrastructure/main.tf" ]]
[[ -f "$tmp/.colors/temporal-fixture/temporal-ansible/application/src/workflows.ts" ]]
echo 'launcher: all checks passed'
