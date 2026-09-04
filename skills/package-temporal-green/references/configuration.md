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
  `provider-backend` (`local`, `s3`, or `r2`).
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

## Compute provider: DigitalOcean (`provider-compute: digitalocean`)

| Key | Required | Meaning |
|---|---|---|
| `digitalocean-region` | yes | Droplet region. `ams3` is where this package was verified; any region with an account default VPC works |
| `digitalocean-size` | yes | Droplet size, e.g. `c-8` |
| `digitalocean-image` | yes | Image slug, `ubuntu-24-04-x64` |
| `digitalocean-backups` | yes | `true` or `false`; DigitalOcean's own Droplet backups |
| `digitalocean-ssh-sources` | yes | CIDRs admitted to TCP 22 |
| `digitalocean-http-sources` | yes | CIDRs admitted to TCP 80 and 443 |
| `digitalocean-name` | no | Droplet name; the profile by default |
| `digitalocean-ssh-keys` | no | An existing account key id; absent means keygen mode |

`c-8` provides 8 dedicated vCPUs and 16 GiB RAM, enough headroom for PostgreSQL,
all four Temporal roles, worker/API, Caddy, image builds, and restart acceptance
on one machine. Smaller shared-CPU sizes are not recommended for this complete
stack.

The Droplet and its firewall (`<name>-firewall`) are named from one resolved
value: `digitalocean-name` when set, otherwise the profile. Changing the name
renames the resources at the provider; the guest hostname lags until a
rebuild.

### Firewall sources

`digitalocean-ssh-sources` must list at least one CIDR, and every entry of
both source keys must be a syntactically valid IPv4 or IPv6 CIDR; both are
checked before any provider call. An empty `digitalocean-http-sources` is
allowed and means no public HTTP: the 80 and 443 rules are one
`dynamic "inbound_rule"` block guarded on a non-empty list, so an empty list
emits no rule, because DigitalOcean rejects a rule with no source as an API
error rather than treating it as closed. The provider firewall admits 22, 80
and 443 from those sources and nothing else. The converge play installs no `ufw` and
manages no guest firewall: Docker's published ports bypass ufw through the
`DOCKER` chain, so the provider firewall is the one that counts.

### VPC

No VPC identifier is accepted: the package looks up the configured region's
existing default VPC at runtime and never creates or pins one.
`digitalocean-vpc-uuid`, `digitalocean-vpc-cidr`, `digitalocean-vpc-id` and
`digitalocean-vpc-name` are all refused.

### The machine keypair

When `digitalocean-ssh-keys` is absent (keygen mode, the default), the first
real `create` generates an ed25519 keypair at `~/.ssh/<profile>` and registers
it as an account key named after the profile; `delete` removes the local
keypair after the machine is destroyed. The key is not generated output: it
survives regeneration of `.colors/`, and a fresh clone on another workstation
does not carry it. A key on disk with no matching state, or an account key of
that name this deployment does not own, refuses the create rather than being
overwritten or adopted. In keygen mode the converge and the `acceptance` verb
both use that key explicitly. Set `digitalocean-ssh-keys` to an existing
account key id to opt out; the package then creates and deletes no key
material and relies on the operator's own identities.

### The `~/.ssh/config` block

A real `create` writes one managed block into `~/.ssh/config`, after the
machine exists and before it is converged, so `ssh <profile>` needs no
address, no user and no `-i` flag:

```sshconfig
# BEGIN <profile> ANSIBLE MANAGED BLOCK
Host <profile>
    HostName <ip>
    User root
    Port 22
    IdentityFile ~/.ssh/<profile>      # keygen mode only
    IdentitiesOnly yes                 # keygen mode only
    StrictHostKeyChecking accept-new
    ForwardAgent no
# END <profile> ANSIBLE MANAGED BLOCK
```

The alias is the profile; there is no separate key for it. The `IdentityFile`
pair appears only in keygen mode, where the package knows the key because it
generated it; with `digitalocean-ssh-keys` set the operator's own arrangements
find the key. `delete` removes the block before the machine is destroyed (the
keypair, by contrast, goes after it). `build` and `--dry-run` never read the
file.

The block is inserted at the top of the file, because `ssh_config` takes the
first value it obtains and a `Host *` stanza above it would win on `User` and
`IdentityFile`. Two layouts make a real create refuse rather than rewrite the
file, each naming the file and the line: a `Host <profile>` stanza outside
the markers (remove or rename it if it is stale, or change `profile` if it
belongs to something else — the package never overwrites it), and an option
standing above the first `Host` or `Match` line, which is global today and
would be captured into this one stanza (move it below the managed block, or
into an explicit `Host *` stanza at the end of the file).

### Provider state

The compute output records `provider = "digitalocean"`. A real `create` or
`delete` reads the existing state first and refuses, before checking any
provider credential, if it records a machine of another provider; a state
recorded before the package wrote the provider is treated as DigitalOcean's,
which every deployment of this package is. An unreadable backend counts as no
state on a create and fails a delete, whether or not `COLORS_PAR_IP` is set;
that override only replaces the cleanup address once the state has been read.

### Retired keys

Two keys earlier releases required are now accepted and ignored, so an
existing `colors.yml` still validates:

- `digitalocean-ssh-authorized-keys` — the operator public-key path the
  package used to fingerprint and look up as an account key. The key model is
  now `digitalocean-ssh-keys` above. A `colors.yml` that carries only the
  retired key is in keygen mode; set `digitalocean-ssh-keys` to the account
  key's id to keep using it.
- `digitalocean-https-sources` — 443 now follows `digitalocean-http-sources`.
