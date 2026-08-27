# Temporal configuration

All keys are non-secret and live in `colors.yml`. Credentials overlay matching
keys at runtime through `COLORS_PAR_*`.

## Required credentials

- `COLORS_PAR_DO_TOKEN`
- `COLORS_PAR_CLOUDFLARE_API_TOKEN`
- Backend credentials required by `provider-backend` (for R2:
  `COLORS_PAR_R2_ACCESS_KEY_ID` and `COLORS_PAR_R2_SECRET_ACCESS_KEY`)

Never export `COLORS_PAR_PROFILE`.

## Desired state

- Identity: `profile`, `workdir`; `profile` isolates every remote state key.
- Providers: `provider-compute: digitalocean`, `provider-dns: cloudflare`, and
  `provider-backend` (`local`, `s3`, or `r2`).
- Guard: keep `compute-prevent-destroy: true` committed.
- Temporal: exact `temporal-version`, all four `temporal-services`, namespace,
  retention, and exact TypeScript SDK version.
- Persistence: PostgreSQL major version and host data/backup directories.
- Reference behavior: hostname, private container port, durable delay, positive
  intentional failure count, larger retry maximum, and `reject` duplicate policy.
- Compute: name, `ams3`, size, Ubuntu image, backup flag, SSH public-key path,
  and ingress CIDRs.
- DNS/TLS: apex application hostname/zone, Cloudflare proxy flag, and
  `letsencrypt` TLS provider.
- Backend: backend-specific non-secret bucket and endpoint values.

VPC keys are intentionally unsupported. The implementation looks up the
configured region's existing default VPC at runtime and assigns the Droplet to
it; it never creates or pins a VPC.

`c-8` provides 8 dedicated vCPUs and 16 GiB RAM, enough headroom for PostgreSQL,
all four Temporal roles, worker/API, Caddy, image builds, and restart acceptance
on one machine. Smaller shared-CPU sizes are not recommended for this complete
stack.
