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
