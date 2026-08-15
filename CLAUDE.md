# CLAUDE.md

## Repository

`temporal` is a Green-only Package Skill for one production-oriented Temporal
stack on a DigitalOcean Droplet. It owns DigitalOcean compute/firewall, discovers
rather than creates the regional default VPC, owns apex Cloudflare DNS, and
converges PostgreSQL, Temporal Server, the reference TypeScript API/worker, and
Caddy. The first consumer is `../temporal-digitalocean`.

Temporal Server 1.31.2 and TypeScript SDK 1.22.0 were discovered as latest
stable official releases on 2026-08-15. The stack invokes Temporal Server's four
production roles and never invokes the development server. Internal ports are
Docker-network-only; only SSH, HTTP, and HTTPS are admitted by cloud and host
firewalls.

## Commands

```sh
bb test
bb golden
./scripts/launcher.sh
./green build
./green create --dry-run
./green create
./green acceptance
./green acceptance --reboot
./green delete
```

Never read or edit `.colors/`, read `.envrc.private`, export
`COLORS_PAR_PROFILE`, weaken `compute-prevent-destroy`, or run real create/delete
without authorization. Build and dry-run are credential-free.

## Invariants

`colors.yml` is flat, non-secret desired state. Validation accumulates errors
and rejects every configurable VPC identifier: the OpenTofu data source looks up
the existing default VPC by `digitalocean-region`. The reference application
rejects duplicate workflow IDs, durably delays, fails its activity for a fixed
positive number of attempts, and returns `TEMPORAL:<workflow-id>:OK` with the
successful attempt number. `green acceptance --reboot` is the complete external
persistence test.

The deployment launcher is a copy of the skill payload. Develop with
`TEMPORAL_LIB_ROOT=../temporal`; after pushing package code run `bb pin`, commit
and push the stamped launcher, then synchronize the installed payload and root
copy. Never invent or hand-edit a SHA.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
