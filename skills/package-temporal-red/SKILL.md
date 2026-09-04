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

## Provider

`provider-compute` selects the machine; `digitalocean` (one Droplet, the
region's default VPC discovered at runtime, a provider firewall in front) is
the one provider this package advertises.

| Provider | Credential | Keys |
|---|---|---|
| `digitalocean` | `COLORS_PAR_DO_TOKEN` | `digitalocean-region`, `digitalocean-size`, `digitalocean-image`, `digitalocean-backups`, `digitalocean-ssh-sources`, `digitalocean-http-sources`; optional `digitalocean-name`, `digitalocean-ssh-keys` |

- `digitalocean-name` is optional and defaults to the profile.
- `digitalocean-ssh-keys` is optional. Leave it out and the package generates
  and owns the machine keypair at `~/.ssh/<profile>` on the first real create
  (keygen mode, the default); set it to an existing account key id to use that
  key instead.
- A real create also writes a managed `Host <profile>` block into
  `~/.ssh/config`, between `# BEGIN <profile> ANSIBLE MANAGED BLOCK` and
  `# END …` markers, so `ssh <profile>` reaches the machine; `delete` removes
  it before the machine is destroyed. The alias is the profile — there is no
  separate key for it. A `Host <profile>` stanza that already exists outside
  those markers, or an option standing above the first `Host` line of the
  file, refuses the create with the file and line named; the package never
  overwrites either. Remove or rename the stanza, move the global options
  below the block or into a `Host *` stanza at the end, or change `profile`.
- `digitalocean-ssh-sources` must list at least one CIDR; every entry of both
  source keys must be a valid IPv4 or IPv6 CIDR. An empty
  `digitalocean-http-sources` means no public HTTP. The provider firewall is
  the only firewall: the converge play installs no `ufw`.
- `digitalocean-ssh-authorized-keys` and `digitalocean-https-sources` are
  retired: accepted, ignored, and documented in the configuration reference.
