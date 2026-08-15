# temporal

A Green Package Skill for a production-oriented, single-machine Temporal
deployment on DigitalOcean. It discovers the configured Amsterdam region's
existing default VPC, provisions one guarded Droplet and firewall, creates apex
Cloudflare DNS, and converges PostgreSQL, all four Temporal Server roles, a
TypeScript worker/API, and Caddy.

Temporal Server is pinned to 1.31.2, the latest stable release discovered from
the [official release feed](https://github.com/temporalio/temporal/releases/tag/v1.31.2)
on 2026-08-15. The reference application pins Temporal TypeScript SDK 1.22.0.
It starts caller-ID workflows, uses a durable timer, intentionally retries an
activity twice, rejects duplicate IDs, and exposes status and deterministic
results.

```sh
npx skills add getcolors/temporal
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

Docker Compose under `/opt/temporal` owns `postgresql`, `temporal`,
`application`, and `caddy`. Use `docker compose ps` and `docker compose logs
--since 1h SERVICE` over SSH. Containers restart automatically after process,
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
bb test
bb golden
./scripts/launcher.sh
```

Inspect every golden diff before accepting it. Pins are managed by `bb pin`
after a clean pushed commit; never hand-edit a SHA.
