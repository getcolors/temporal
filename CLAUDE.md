# CLAUDE.md

## Repository

`temporal` is a tri-colour Package Skill (green, red, blue) for one
production-oriented Temporal stack on a DigitalOcean Droplet. It owns
DigitalOcean compute and the provider firewall, discovers rather than creates
the regional default VPC, generates and owns the machine's SSH keypair and a
`~/.ssh/config` block, owns apex Cloudflare DNS, and converges PostgreSQL,
Temporal Server, the reference TypeScript API/worker, and Caddy. The first
consumer is `../temporal-digitalocean`.

Temporal Server 1.31.2 and TypeScript SDK 1.22.0 were discovered as latest
stable official releases on 2026-08-15. The stack invokes Temporal Server's four
production roles and never invokes the development server. Internal ports are
Docker-network-only; only SSH, HTTP, and HTTPS are admitted, by the provider
firewall alone.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Each colour has six namespaces: `validate` (the
registry, the spec and the package's own checks), `ssh` (the keypair, wrapping
ONCE's), `ssh-config` (the `~/.ssh/config` block's alias, markers and the two
local refusals — this package's own, not ONCE's), `tools` (the stages),
`workflow` (the graph and `start-step`) and `operator` (the `acceptance`
verb); red also carries `once.ts`, the path-resolution shim for ONCE's
unexported `ssh.ts`. The templates live under
`tools/infrastructure/<provider>/` (one directory, `digitalocean`),
`tools/tofu/` (DNS), `tools/ansible/` (the converge) and
`tools/ansible-local/` (the three-file local stage that writes the
`~/.ssh/config` block). Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which renders
both fixtures through every colour and diffs the trees — and the colour
template trees (`red/resources`, blue's embedded `resources/`) — byte for
byte. The fixtures and the goldens are shared across colours at the
repository root — `test/fixtures/` and `test/resources/golden/` — with
`green/test/fixtures` and `green/test/resources` symlinks pointing at them.
Each colour dir holds a launcher symlink to its skill payload (`green/green`,
`red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two keypair modes, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
cd green && ./green acceptance
cd green && ./green acceptance --reboot
cd green && ./green delete     # guarded and destructive
```

Never read or edit `.colors/`, read `.envrc.private`, export
`COLORS_PAR_PROFILE`, weaken `compute-prevent-destroy`, or run real
create/delete without authorization. Build and dry-run are credential-free.

## Invariants

`colors.yml` is flat, non-secret desired state. Validation accumulates errors
and rejects every configurable VPC identifier: the OpenTofu data source looks up
the existing default VPC by `digitalocean-region`. The reference application
rejects duplicate workflow IDs, durably delays, fails its activity for a fixed
positive number of attempts, and returns `TEMPORAL:<workflow-id>:OK` with the
successful attempt number. `acceptance --reboot` is the complete external
persistence test — every colour carries the identical embedded bash script,
which passes the generated key to `ssh` in keygen mode.

## The Compute Provider Standard, and what is delegated

The package conforms to the workspace Compute Provider Standard
(`../workspace/standards/compute-provider.md`) by **delegation**: the
operations — the `:provider-compute must be one of` refusal, the required
keys, secrets and OpenTofu environment of the selected entry, the CIDR
grammar and the source rules, the per-provider checks (name rules and
DigitalOcean's refusal of `vpc-uuid` and `vpc-cidr`), the provider-switch and
legacy-state refusals, the one up-front state read, `fallback-params`,
`resolved-compute` and `adopt-state` — live in ONCE's `compute` namespace,
called with `validate/spec`. What stays here is the data and the wiring: the
one-entry registry (`digitalocean`, requiring region, size, image, backups
and the two source lists — what the template interpolates, and nothing the
sibling standards make optional), the default provider, the `:sources` map
(`ssh-sources` non-empty, `http-sources` may be empty), the template,
`state-output`, `start-step`, and the graph. Two package-local checks sit
beside ONCE's: `digitalocean-vpc-id` and `digitalocean-vpc-name` are refused
too, and `digitalocean-backups` must be a boolean. The three-colour matrix of
the delegated operations is tested in ONCE; this package's tests keep one
wiring test per safety boundary and one spec-content test per colour.

**The default provider is DigitalOcean**, which is what a legacy state —
`params` without `provider` — is taken to be. Every deployment this package
ever made ran there, so `temporal-digitalocean`'s R2 state, which may hold
such a `params`, passes the legacy rule on DigitalOcean and would be refused
on any other provider.

**`COLORS_PAR_IP` no longer skips the state read.** It survives as a local
wrapper around `compute/adopt-state`, in posthog's shape: it replaces the
recorded address only after a successful read. An unreadable backend fails a
real delete closed with ONCE's wording whether or not it is set, because §4
says it must; the old message that offered `COLORS_PAR_IP` as a way round the
read is gone with the behaviour.

**The hardcoded `ams3` check is gone.** The registry requires that a region
is set; `colors.yml` recommends `ams3` as the region this package was
verified in.

**`ufw` is gone from the converge play, deliberately.** Standard §5 forbids a
play managing the guest firewall for 22/80/443 and says why: Docker's
published ports bypass ufw through the `DOCKER` chain, so the guest firewall
never protected the published stack and the provider firewall is the only
layer that counts. The old task also opened 22 to the *first*
`digitalocean-ssh-sources` CIDR alone. `scripts/golden.sh` fails if `ufw`
reappears in the rendered play.

## The machine keypair and the two retired keys

The package adopts keygen mode of the SSH Keypair Standard:
`digitalocean-ssh-keys` and `digitalocean-name` are optional, absence of the
key means the deployment generates and owns `~/.ssh/<profile>` (ONCE's `ssh`,
wrapped by `temporal.ssh` with a build-time placeholder home), the compute
template carries the `<% if ssh-keygen %>` branches whose opt-out side
contributes no byte, `ansible.cfg` names the private key in keygen mode, the
`acceptance` verb passes it to `ssh`, and the delete graph removes the key
strictly **after** the compute destroy (`:temporal/ssh-cleanup`).

The pre-standard key model — `digitalocean-ssh-authorized-keys: <path>`,
fingerprinted by shelling out to `ssh-keygen -E md5 -lf` on real events and
looked up with `data "digitalocean_ssh_keys"` — is gone, data source and
shell-out both. The key is now `digitalocean-ssh-keys`: a literal account key
id is opt-out, absence is keygen. `digitalocean-ssh-authorized-keys` and
`digitalocean-https-sources` (443 now follows `http-sources`) are **retired:
accepted and ignored**, named as such in every `references/configuration.md`.
The consequence for `../temporal-digitalocean` is worth saying plainly: its
`colors.yml` carries the retired key and no `digitalocean-ssh-keys`, so on
the day its payload is refreshed it is in keygen mode; keep it there, or set
`digitalocean-ssh-keys` to the account key's id first.

## The `~/.ssh/config` block

The package conforms to the workspace SSH Config Standard
(`../workspace/standards/ssh-config.md`) by copying its reference
implementation as `rybbit` did, and it was born conforming: the marker is
`# BEGIN <profile> ANSIBLE MANAGED BLOCK` with no package prefix, so
`owned-markers` is a one-element set and no migration window exists. The
`temporal-ansible-local` stage is one `blockinfile` task against
`~/.ssh/config`, run on `localhost` with `connection: local`, giving the
operator `ssh <profile>` instead of an address, a user and an identity file.

The play is **this package's own copy**, deliberately not shared with ONCE's
(standard §7): the file is shared with every host the operator reaches, so an
unrelated upstream change must not be able to rewrite it at pin-bump time.
`../workspace/scripts/package-copies.py` is the net that keeps every
package's copy in step; run it after touching `ssh_config`, the local play or
the red `once.ts` shim.

Address, user, alias and `block_state` arrive as **Ansible extra-vars, never
through Selmer**, which keeps `build` byte-identical across workstations and
addresses out of the goldens; the one Selmer conditional is the
`IdentityFile`/`IdentitiesOnly` pair, rendered in keygen mode only.

Create writes the block after compute and before DNS and convergence
(`:temporal/infrastructure → :temporal/ssh-config → :temporal/dns`). Delete
removes it *before* the destroy, the reverse of the keypair: a block that
outlives its host is stale but harmless, while a key removed early locks you
out of a machine that still exists. The two orders disagree on purpose.

The block is inserted with `insertbefore: BOF`. Two local checks run on a real
create only, never on `build` or `--dry-run`: a `Host <profile>` stanza
outside this package's markers is an error naming the file and the line,
never overwritten; an option above the first `Host` or `Match` line is an
error too, because a BOF insert would capture that global option into one
stanza. Both messages name the recovery. A hand-written `Host
temporal-digitalocean` stanza in the operator's `~/.ssh/config` therefore
makes a real create refuse **by design**; that is the standard working, not
a bug to work around.

## The two-fixture golden and parity axis

The SSH Keypair Standard has two modes, so there are two fixtures under
`test/fixtures/`: `colors.yml` (opt-out, profile `temporal-fixture`, an
explicit `digitalocean-ssh-keys` and a name equal to the profile) and
`keygen.yml` (`temporal-keygen-fixture`, neither key). One committed golden
tree per profile lives under `test/resources/golden/local/`. **The opt-out
golden is the shape a temporal deployment's state holds.** Adopting the
standards changed it by exactly five things and nothing else: (a) the `ufw`
package and the host-firewall task left the converge play; (b) the
`data "digitalocean_ssh_keys"` fingerprint lookup left and `ssh_keys` became
the literal id; (c) nothing by itself — the 443 rule reads `http-sources`
now, and the fixture's two lists were equal; (d) `params` gained
`provider = "digitalocean"`; (e) the 80 and 443 TCP rules became one
`dynamic "inbound_rule"` block guarded on a non-empty
`digitalocean-http-sources`, rybbit's shape, so an empty list means no public
HTTP rather than a DigitalOcean API error — no live droplet existed to move,
and the block opens the same two TCP ports as before (no UDP 443, which this
firewall never admitted). Every resource address, the
`-firewall` suffix, `backups = <{ digitalocean-backups }>` and the `region =`
form of the VPC lookup are untouched, and `temporal-ansible-local/` was added
beside the existing stages. `scripts/golden.sh` checks green against both
trees and asserts the keypair standard on each (a keygen tree declares the
profile-named key resource and references it by attribute; an opt-out tree
creates none and keeps the literal id; no rendered tree names `$HOME/.ssh`),
the config standard's §6 (no dotted quad under `temporal-ansible-local`), and
that no `ufw` appears in the rendered converge play. `scripts/parity.sh`
renders both through every colour.

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** (`38e3cd6`) — ONCE's own parity is what guarantees its colours
agree per commit. The green pin (`3f33f5d`) is a floor coupled to that ONCE
rev: ONCE 38e3cd6 trusts the SDK's step error alone when it reads state, and
green 3f33f5d is where the SDK reports a tofu launch failure (a missing stage
directory or binary) as that step error, the way red and blue always did; an
older green under this ONCE would crash a fresh-clone create instead of
reporting its credentials, so the two pins move together. ONCE supplies the
backend provider registry, the `compute` namespace (the Compute Provider
Standard's operations over this package's own registry) and the `ssh`
namespace (the SSH Keypair Standard); the DNS credential map is this package's
own. The red launcher's `PINS`, the blue launcher's PEP 723 block and
`green/tasks/pin.clj` carry the same ONCE rev. `blue/pyproject.toml` carries a
`[tool.uv] override-dependencies` block, now redundant because
`package-once-blue` at `38e3cd6` pins the same Blue rev, and kept because it
is harmless and would make this package's Blue pin win were ONCE ever to pin
an older one again.

Use `TEMPORAL_LIB_ROOT` (the repository root, for every colour; red also
accepts the `red/` dir directly), `GREEN_LIB_ROOT`, and `ONCE_LIB_ROOT` for
working-tree development. Final launchers use a pushed SHA managed by `bb pin`
(in `green/`), which stamps all three payloads from their unpinned birth forms;
deployment launchers are copies, not symlinks. Never invent or hand-edit a SHA.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
