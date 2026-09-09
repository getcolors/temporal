---
name: package-temporal-blue
description: Provision and operate a production-oriented single-machine Temporal deployment through colors-compute using Blue.
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
`COLORS_PAR_PROFILE`, edit `.colors/`, weaken
`compute-prevent-destroy`, or run a real create/delete without authorization.
Only the HTTPS reference API is public; PostgreSQL and Temporal ports stay
private. Use `acceptance --reboot` for the full durable-recovery check.

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

The `acceptance` verb reads library-owned compute state before running and
uses its observed SSH address, login and identity. Missing, destroyed or
unreadable state refuses execution. `--reboot` performs the full persistence
check; the public DNS name is only an HTTPS endpoint, never the SSH target.
