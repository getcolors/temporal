"""Desired-state and credential validation, the port of
io.github.getcolors.temporal.validate. The compute registry, the spec and the
DNS credential map are this package's own; the operations over the registry
are ONCE's `compute`, and the state-backend registry is ONCE's.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import compute as once_compute
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

from .utils import provider

profile_par = par_name("profile")


def env_errors(env: dict) -> list[str]:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


# provider-compute -> what that choice implies (Compute Provider Standard §2).
#
# `required` are the non-secret keys that provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, and `tofu-env` the
# subset OpenTofu reads from the process environment itself. Keeping the three
# together is what stops a provider being validated against one set of keys
# and run with another. The keys of this map are the advertised providers; a
# provider without a template directory and a golden is not advertised, and
# this package advertises one.
#
# Two keys the template reads are deliberately not required.
# `digitalocean-name` is an optional override of the profile (Compute Name
# Standard), and `digitalocean-ssh-keys` is meaningful by its absence (SSH
# Keypair Standard).
compute_providers = {
    "digitalocean": {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-backups", "digitalocean-ssh-sources",
                     "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running. A legacy state -- `params` without
# `provider` -- is whatever this value says it is; every deployment this
# package ever made ran on DigitalOcean, so a legacy `temporal-digitalocean`
# state is accepted there and refused on any other provider.
default_compute_provider = "digitalocean"

# How this package describes itself to ONCE's `compute`, the Compute Provider
# Standard's operations over a package-owned registry. The registry and the
# default are the data above; `sources` names the firewall lists the template
# reads -- SSH must list at least one CIDR, an empty HTTP list means no public
# HTTP. The name rules are ONCE's.
spec: once_compute.ComputeSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources"], "may_be_empty": ["http-sources"]},
}

# Every key desired state must carry whichever provider is selected. The
# provider-scoped keys come from `compute_providers`.
required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy", "temporal-version", "temporal-services",
    "temporal-namespace", "temporal-retention-days", "temporal-typescript-sdk-version",
    "node-version", "postgres-version", "postgres-data-dir", "temporal-data-dir",
    "reference-application-host", "reference-application-port",
    "reference-workflow-delay-seconds", "reference-activity-failures",
    "reference-activity-maximum-attempts", "reference-duplicate-policy",
    "cloudflare-zone", "cloudflare-proxied", "tls-provider",
]


def missing(x) -> bool:
    return x is None or (isinstance(x, str) and not x.strip())


_host_re = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
_version_re = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")

# The package-local half of the DigitalOcean VPC refusal. ONCE's
# `provider_errors` refuses `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr`
# (Compute Provider Standard §5); this package has always refused the two
# other spellings a hand-edited colors.yml is likely to carry, and keeps them
# beside ONCE's.
forbidden_vpc_keys = ["digitalocean-vpc-id", "digitalocean-vpc-name"]

# `<provider>-<suffix>`: desired state names compute keys after the provider,
# so the shared steps reach them through the selected provider rather than a
# fixed prefix. ONCE's; named here so `tools` reads the same.
compute_key = once_compute.compute_key

# What this deployment's machine is called: `digitalocean-name` when present,
# else the profile (Compute Name Standard). ONCE's; the Droplet, the firewall
# and `params.name` derive every label from this one answer.
compute_name = once_compute.compute_name


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


# A source list as desired state or an overlay string carries it. ONCE's, so
# the validator and the template can never disagree about what an entry is.
cidrs = once_compute.cidrs


def _is_integer(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _is_bool(x) -> bool:
    return isinstance(x, bool)


def state_errors(opts: dict) -> list[str]:
    """Every problem with desired state at once: the missing keys (this
    package's and the selected provider's), the package's own checks, then the
    Compute Provider Standard's -- selection, the network contract and the
    provider rules, DigitalOcean's VPC refusal among them -- which are ONCE's
    over `spec`."""
    errors: list[str] = []
    for key in [*required, *once_compute.required_keys(spec, opts)]:
        if missing(opts.get(key)):
            errors.append(f":{key} is required")
    if provider(opts.get("provider-dns")) != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not _is_bool(opts.get("compute-prevent-destroy")):
        errors.append(":compute-prevent-destroy must be true or false")
    if opts.get("provider-compute") == "digitalocean" and not _is_bool(opts.get("digitalocean-backups")):
        errors.append(":digitalocean-backups must be true or false")
    if not _version_re.fullmatch(str(opts.get("temporal-version"))):
        errors.append(":temporal-version must be an exact x.y.z version")
    if not _version_re.fullmatch(str(opts.get("temporal-typescript-sdk-version"))):
        errors.append(":temporal-typescript-sdk-version must be an exact x.y.z version")
    if list(opts.get("temporal-services") or []) != ["frontend", "history", "matching", "worker"]:
        errors.append(":temporal-services must contain frontend, history, matching,"
                      " and worker in that order")
    if opts.get("reference-duplicate-policy") != "reject":
        errors.append(":reference-duplicate-policy must be reject")
    failures = opts.get("reference-activity-failures")
    attempts = opts.get("reference-activity-maximum-attempts")
    if not (_is_integer(failures) and _is_integer(attempts) and 0 < failures < attempts):
        errors.append(":reference-activity-maximum-attempts must exceed a positive"
                      " :reference-activity-failures")
    if not _host_re.fullmatch(str(opts.get("reference-application-host"))):
        errors.append(":reference-application-host must be a fully qualified hostname")
    if opts.get("reference-application-host") != opts.get("cloudflare-zone"):
        errors.append(":reference-application-host must be the Cloudflare zone apex")
    if opts.get("provider-compute") == "digitalocean":
        for key in forbidden_vpc_keys:
            if key in opts:
                errors.append(f":{key} must not be configured; the default regional VPC"
                              " is discovered at runtime")
    errors += once_compute.state_errors(spec, opts)
    return errors


def _backend_entry(opts: dict) -> dict:
    return once_providers.get("provider-backend", {}).get(opts.get("provider-backend")) or {}


def backend_secrets(opts: dict) -> list[str]:
    return _backend_entry(opts).get("secrets", [])


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return once_compute.tofu_env(spec, opts)
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        return _backend_entry(opts).get("tofu-env", {})
    return {}


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real create or delete needs: the selected compute
    provider's, Cloudflare's, and the backend's."""
    keys = [*once_compute.secrets(spec, opts), "cloudflare-api-token", *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if missing(opts.get(key))]
