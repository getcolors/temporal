# CLAUDE.md

## Repository

`temporal` is a tri-colour Package Skill (green, red, blue) for one
production-oriented Temporal stack on a DigitalOcean Droplet. It owns
DigitalOcean compute/firewall, discovers rather than creates the regional
default VPC, owns apex Cloudflare DNS, and converges PostgreSQL, Temporal
Server, the reference TypeScript API/worker, and Caddy. The first consumer is
`../temporal-digitalocean`.

Temporal Server 1.31.2 and TypeScript SDK 1.22.0 were discovered as latest
stable official releases on 2026-08-15. The stack invokes Temporal Server's four
production roles and never invokes the development server. Internal ports are
Docker-network-only; only SSH, HTTP, and HTTPS are admitted by cloud and host
firewalls.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which renders
the one fixture through every colour and diffs the trees — and the colour
template trees (`red/resources`, blue's embedded `resources/`) — byte for
byte. The fixture and the goldens are shared across colours at the repository
root — `test/fixtures/` and `test/resources/golden/` — with
`green/test/fixtures` and `green/test/resources` symlinks pointing at them.
Each colour dir holds a launcher symlink to its skill payload (`green/green`,
`red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, one fixture, byte for byte
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
persistence test — every colour carries the identical embedded bash script.

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** (`98d3cfa`) — ONCE's own parity is what guarantees its colours
agree per commit. This package deliberately stays on that older ONCE pin: a
bump would adopt the SSH-keypair default and churn every golden, and is its own
change. ONCE supplies only the state-backend provider registry here; the
compute and DNS credential maps are this package's own.
`blue/pyproject.toml` carries a `[tool.uv] override-dependencies` block because
`package-once-blue@98d3cfa` pins an older Blue rev (`369c5aa`); the override
makes this package's Blue pin win.

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
