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
from . import compute
from colors_compute.ssh import _mode
from package_once_blue.validate import providers as once_providers

from .utils import provider

profile_par = par_name("profile")


def env_errors(env: dict) -> list[str]:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


default_compute_provider="digitalocean"

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

def keygen(opts):
    try: return _mode(opts)['mode'] == 'managed'
    except ValueError: return True


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
    for key in required:
        if missing(opts.get(key)):
            errors.append(f":{key} is required")
    if provider(opts.get("provider-dns")) != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("s3", "r2"):
        errors.append(":provider-backend must be s3 or r2")
    if not _is_bool(opts.get("compute-prevent-destroy")):
        errors.append(":compute-prevent-destroy must be true or false")
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
    errors += [f"retired option :{key} must be removed" for key in ("digitalocean-vpc-id", "digitalocean-vpc-name") if key in opts]
    errors += compute.errors(opts)
    return errors


def _backend_entry(opts: dict) -> dict:
    return once_providers.get("provider-backend", {}).get(opts.get("provider-backend")) or {}


def backend_secrets(opts: dict) -> list[str]:
    return _backend_entry(opts).get("secrets", [])


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {}
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        return _backend_entry(opts).get("tofu-env", {})
    return {}


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real create or delete needs: the selected compute
    provider's, Cloudflare's, and the backend's."""
    keys = ["cloudflare-api-token", *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if missing(opts.get(key))]
