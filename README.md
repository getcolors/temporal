# temporal

A tri-colour Package Skill (green, red, blue) for one production-oriented
Temporal stack. The shared colors-compute library owns its VM, provider
firewall, remote S3/R2 state and machine keys. The package owns apex Cloudflare
DNS, application Ansible, PostgreSQL, all four Temporal Server roles, a
TypeScript worker/API and Caddy. Only SSH and HTTP(S) are publicly admitted;
the converge play installs no `ufw`.

## Compute ownership

The pinned `colors-compute` library owns provider selection, remote S3/R2
state, deployment coordination, machine keys, network policy and the single
node. This package supplies singleton topology and SSH/HTTP ingress, then
uses the returned address, login user and SSH identity for its application
steps. New provider support belongs in the library; consumers update its pin.
The application needs a supported Ubuntu image and sufficient memory for
Temporal and the reference application. Build first to check adapter capabilities.

Use `temporal-ssh-sources` and `temporal-http-sources` for neutral CIDR
allowlists. Existing selected-provider source options remain compatible.
External account key references require `ssh-private-key-path`; external
private keys are never generated or removed. The local SSH block writes
`IdentityFile` only for a managed deployment key.

Existing `<profile>/temporal-infrastructure.tfstate` is refused before
compute mutation. Do not remove it to bypass this check: migrate ownership
explicitly or destroy the old deployment through its original version first.
Unreadable state and provider mismatches fail closed.

The default adapter remains `digitalocean`. The node requests TCP22/80/443;
Temporal and PostgreSQL ports remain private to Compose.

Temporal Server is pinned to 1.31.2, the latest stable release discovered from
the [official release feed](https://github.com/temporalio/temporal/releases/tag/v1.31.2)
on 2026-08-15. The reference application pins Temporal TypeScript SDK 1.22.0.
It starts caller-ID workflows, uses a durable timer, intentionally retries an
activity twice, rejects duplicate IDs, and exposes status and deterministic
results.

The same package ships in three implementations of one behaviour: `green`
(Clojure/Babashka, canonical), `red` (TypeScript/Bun), and `blue` (Python/uv).
Pick one launcher; they render byte-identical artifacts.

```sh
npx skills add getcolors/temporal          # green; -green/-red/-blue selects a colour
cp .agents/skills/package-temporal-green/green ./green
./green build
./green create --dry-run
./green create
./green acceptance
./green acceptance --reboot
```

Desired state is the non-secret `colors.yml`. Credentials are `COLORS_PAR_*`
exports in ignored `.envrc.private`; never set `COLORS_PAR_PROFILE`. Generated
`.colors/` output is private, reproducible state and must not be edited or
committed.

## Operations

Docker Compose under `/opt/temporal` owns `postgresql`, one-shot `schema`,
`temporal`, private `admin-tools`, `application`, and `caddy`. Use
`docker compose ps` and `docker compose logs
--since 1h SERVICE` over SSH — `ssh <profile>` works, because a real create
writes the managed `~/.ssh/config` block. Containers restart automatically after process,
Docker, or Droplet restarts. PostgreSQL data is under `/data/postgresql`; daily
logical dumps are retained for seven days under `/data/temporal/backups`, and
the desired Droplet enables DigitalOcean backups.

A normal `create` converges safely. Upgrade by changing exact versions in
`colors.yml`, reviewing upstream upgrade and schema compatibility guidance,
running `build` and `create --dry-run`, taking a backup, then running `create`.
Restore requires a fresh compatible stack and an operator-controlled
`pg_restore`/`psql` import from a verified dump or a DigitalOcean backup. Never
restore over a running database.

This is deliberately one failure domain: no service redundancy, database
replica, cross-region failover, or zero-downtime host maintenance. Local dumps
die with a lost Droplet; DigitalOcean backups reduce but do not eliminate that
risk. Production requiring HA needs a multi-node Temporal topology and an
external highly available database.

## Development

```sh
cd green && bb test && bb golden
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh
./scripts/launcher.sh
```

Green is canonical; a behavioural change lands in all three colours in the same
commit and passes `scripts/parity.sh`, which renders both fixtures — opt-out
and keygen mode of the machine keypair — through every colour and diffs the
rendered trees and the template trees byte for byte. Inspect every golden diff
before accepting it. Pins are managed by `bb pin` (in `green/`) after a clean
pushed commit; never hand-edit a SHA.
