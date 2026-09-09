# Temporal configuration

All keys are non-secret and live in `colors.yml`. Credentials overlay matching
keys at runtime through `COLORS_PAR_*`.

## Required credentials

- `COLORS_PAR_DO_TOKEN` — the selected compute provider's; `digitalocean` is
  the one provider this package advertises
- `COLORS_PAR_CLOUDFLARE_API_TOKEN`
- Backend credentials required by `provider-backend` (for R2:
  `COLORS_PAR_R2_ACCESS_KEY_ID` and `COLORS_PAR_R2_SECRET_ACCESS_KEY`)

Never export `COLORS_PAR_PROFILE`.

## Desired state

- Identity: `profile`, `workdir`; `profile` isolates every remote state key,
  names the machine, its keypair and its `~/.ssh/config` alias.
- Providers: `provider-compute: digitalocean`, `provider-dns: cloudflare`, and
  `provider-backend` (`s3` or `r2`).
- Guard: keep `compute-prevent-destroy: true` committed.
- Temporal: exact `temporal-version`, all four `temporal-services`, namespace,
  retention, and exact TypeScript SDK version.
- Persistence: PostgreSQL major version and host data/backup directories.
- Reference behavior: hostname, private container port, durable delay, positive
  intentional failure count, larger retry maximum, and `reject` duplicate policy.
- Compute: the DigitalOcean keys below.
- DNS/TLS: apex application hostname/zone, Cloudflare proxy flag, and
  `letsencrypt` TLS provider.
- Backend: backend-specific non-secret bucket and endpoint values.

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
External account key references may use `ssh-private-key-path` or operator/agent SSH configuration; external
private keys are never generated or removed. The local SSH block writes
`IdentityFile` only for a managed deployment key.

Existing `<profile>/temporal-infrastructure.tfstate` is refused before
compute mutation. Do not remove it to bypass this check: migrate ownership
explicitly or destroy the old deployment through its original version first.
Unreadable state and provider mismatches fail closed.

The default adapter remains `digitalocean`. The node requests TCP22/80/443;
Temporal and PostgreSQL ports remain private to Compose.

No private network is requested by default. Explicit supported network
references are validated by the library without owning existing networks.
The library retains `digitalocean-backups` as a boolean alias for the adapter's
backup capability; unsupported capabilities refuse before provider execution.
S3 state uses ambient AWS credentials. R2 state uses `r2-bucket`, `r2-endpoint`
and the two explicit R2 backend credentials. Local compute state is unsupported.

External key references may use `ssh-private-key-path` or operator/agent SSH configuration; the library never
generates or deletes external key material. Managed key cleanup occurs only
after all owned resources are destroyed. The local SSH updater locks and
atomically updates `Host <profile>` with the observed IP/login, writing
`IdentityFile` and `IdentitiesOnly` only for managed keys.

The acceptance verb inspects owned compute state and uses the observed IP,
login and key for SSH; public DNS is used only for HTTPS. An unreadable or
destroyed deployment refuses acceptance before the shell script runs. Non-root
logins use passwordless sudo for Docker restart or reboot.

`digitalocean-https-sources` is ignored; HTTP sources cover ports 80 and 443.
The library validates legacy SSH aliases; conflicting key declarations refuse. Remove `digitalocean-vpc-id` and `digitalocean-vpc-name`;
these unsupported retired spellings are refused. An explicit cleanup IP can
only replace the target after a successful owned-state read during deletion.
