---
name: package-temporal-red
description: Provision and operate a production-oriented single-machine Temporal deployment on DigitalOcean using Red.
---

# Temporal Package Skill

Use the bundled `red` launcher against a non-secret `colors.yml`.

```sh
./red build
./red create --dry-run
./red create
./red acceptance
./red acceptance --reboot
./red delete
```

Read `references/configuration.md` before editing desired state. Put credentials
only in ignored `.envrc.private` as `COLORS_PAR_*`. Never export
`COLORS_PAR_PROFILE`, edit `.colors/`, configure a VPC identifier, weaken
`compute-prevent-destroy`, or run a real create/delete without authorization.
Only the HTTPS reference API is public; PostgreSQL and Temporal ports stay
private. Use `acceptance --reboot` for the full durable-recovery check.
