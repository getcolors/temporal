---
name: package-temporal-green
description: Provision and operate a production-oriented single-machine Temporal deployment on DigitalOcean using Green.
---

# Temporal Package Skill

Use the bundled `green` launcher against a non-secret `colors.yml`.

```sh
./green build
./green create --dry-run
./green create
./green acceptance
./green acceptance --reboot
./green delete
```

Read `references/configuration.md` before editing desired state. Put credentials
only in ignored `.envrc.private` as `COLORS_PAR_*`. Never export
`COLORS_PAR_PROFILE`, edit `.colors/`, configure a VPC identifier, weaken
`compute-prevent-destroy`, or run a real create/delete without authorization.
Only the HTTPS reference API is public; PostgreSQL and Temporal ports stay
private. Use `acceptance --reboot` for the full durable-recovery check.
