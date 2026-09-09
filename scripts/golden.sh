#!/usr/bin/env bash
set -euo pipefail

# Green's regression net against the committed goldens: render every fixture
# and diff against committed output. scripts/parity.sh is the net across
# colours.
#
# Two fixtures cover managed/external keys. Preserve the application secrecy and no-ufw checks.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

accept=0
[[ ${1:-} == --accept ]] && accept=1

status=0
for variant in colors keygen; do
  fixture="$tmp/$variant.yml"
  sed "s#WORKDIR#$tmp/work#" "$root/test/fixtures/$variant.yml" > "$fixture"
  (cd "$root/green" && TEMPORAL_LIB_ROOT="$root" ./green build -f "$fixture" >/dev/null)

  profile=$(sed -n 's/^profile: //p' "$fixture")
  actual="$tmp/work/$profile"
  golden="$root/test/resources/golden/local/$profile"
  mode=external; [[ $variant == keygen ]] && mode=managed
  python3 "$root/scripts/check-compute-plan.py" "$actual" "$mode"
  play="$actual/temporal-ansible/main.yml"

  # No rendered artefact may carry a real secret into a committed golden.
  # Checked before --accept copies anything.
  if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$actual"; then
    echo "golden: a credential-shaped value was rendered for $profile" >&2; exit 1
  fi
  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$actual"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # Compute Provider Standard §5: the provider firewall is the load-bearing
  # layer and the converge play manages no ufw for 22/80/443. A rendered play
  # that names ufw has re-grown the guest firewall this package removed.
  if grep -q 'ufw' "$play"; then
    echo "golden: $profile rendered ufw into the converge play; the provider firewall is the only firewall" >&2; exit 1
  fi
  # The converge play takes its address from the inventory at run time, so
  # the rendered play itself must carry no machine address — a literal one
  # would be a workstation- or deployment-specific byte in a golden. Loopback
  # and the unspecified address are not machine addresses and are allowed.
  if grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' "$play" | grep -Evq '^(127\.0\.0\.1|0\.0\.0\.0)$'; then
    echo "golden: $profile rendered a machine address into the converge play" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes the address, the user and the
  # alias as Ansible extra-vars, never through Selmer, so its rendered playbook
  # carries no address at all. A dotted quad here means someone templated a
  # run-time fact and the goldens stopped being workstation-independent.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$actual/temporal-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi
  if [[ $accept == 1 ]]; then
    rm -rf "$golden"; mkdir -p "$(dirname "$golden")"; cp -a "$actual" "$golden"; continue
  fi
  [[ -d "$golden" ]] || { echo "golden missing for $profile; inspect build then run bb golden:accept" >&2; exit 1; }
  diff -ru "$golden" "$actual" || status=1
done

exit "$status"
