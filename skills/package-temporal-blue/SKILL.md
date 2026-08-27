---
name: package-temporal-blue
description: Provision and operate a production-oriented single-machine Temporal deployment on DigitalOcean using Blue.
---

# Temporal Package Skill

Use the bundled `blue` launcher against a non-secret `colors.yml`.

```sh
./blue build
./blue create --dry-run
./blue create
./blue acceptance
./blue acceptance --reboot
./blue delete
```

Read `references/configuration.md` before editing desired state. Put credentials
only in ignored `.envrc.private` as `COLORS_PAR_*`. Never export
`COLORS_PAR_PROFILE`, edit `.colors/`, configure a VPC identifier, weaken
`compute-prevent-destroy`, or run a real create/delete without authorization.
Only the HTTPS reference API is public; PostgreSQL and Temporal ports stay
private. Use `acceptance --reboot` for the full durable-recovery check.
