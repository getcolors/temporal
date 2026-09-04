"""OpenTofu and Ansible stages for the single-machine Temporal stack, the port
of io.github.getcolors.temporal.tools."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed
from package_once_blue import compute as once_compute

from . import ssh_config, utils, validate

infrastructure_tool = "temporal-infrastructure"
dns_tool = "temporal-dns"
ansible_tool = "temporal-ansible"
ansible_local_tool = "temporal-ansible-local"

ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="temporal")


def template(path: str, file: str) -> dict:
    name = f"tools/{path.replace('.', '/')}/{file}"
    source = ROOT / name
    if not source.is_file():
        raise StepError(f"template not found: {name}")
    return {"name": name, "content": source.read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


# The source lists as validate parses them, so the template and the
# validator can never disagree about what an entry is. ONCE's.
cidrs = validate.cidrs


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    mapping: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        mapping.update(validate.tofu_env(opts, slot))
    env = {env_var: str(opts.get(key))
           for key, env_var in mapping.items()
           if opts.get(key) is not None and str(opts.get(key))}
    return env or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


# What `build` and `--dry-run` render in place of a compute output: the
# documentation address, shaped like the selected provider's real `params` so
# every later stage sees the same keys either way. ONCE's.
fallback_params = once_compute.fallback_params

# Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
# carries no `ip`. ONCE's; `infrastructure_step` is what wires it.
resolved_compute = once_compute.resolved_compute

# The compute stage's `params` output, untouched. ONCE's.
output_params = once_compute.output_params

# `<provider>-<suffix>`, the selected provider's key. ONCE's, via validate.
compute_key = validate.compute_key

# The machine's name: `digitalocean-name` when present, else the profile.
# ONCE's, via validate; the Droplet, the firewall and `params.name` derive
# every label from it.
compute_name = validate.compute_name


def infrastructure_data(opts: dict) -> dict:
    """Template values for the compute stage. The name, the keypair mode and
    the source lists are resolved here once, so the template interpolates
    values and never branches on which provider it belongs to. An empty
    `digitalocean-http-sources` (allowed by the standard, meaning no public
    HTTP) reaches the template as `[]`, whose dynamic 80/443 block then
    emits no rule: DigitalOcean rejects a rule with no source as an API error
    rather than a closed port."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "compute-name": compute_name(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, compute_key(opts, "ssh-sources"))),
            "http-sources-hcl": tofu.hcl_list(cidrs(opts, compute_key(opts, "http-sources")))}


def infrastructure_specs(opts: dict) -> list[dict]:
    """Providers are selected by template directory, not by conditionals
    inside one file (Compute Provider Standard §3)."""
    dir = tool_dir(opts, infrastructure_tool)
    return [spec(template(f"infrastructure.{opts.get('provider-compute')}", "main.tf"),
                 f"{dir}/main.tf", infrastructure_data(opts))]


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    result = await tofu.tofu_with_spec(opts, infrastructure_specs(opts), dir=dir,
                                       env=credential_env(opts, "provider-compute"))
    if failed(result):
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return resolved_compute(result, fallback_params(opts), output_params(result))


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    data = {**opts, "ip": opts.get("ip") or fallback_params(opts)["ip"]}
    return await tofu.tofu_with_spec(
        opts, [spec(template("tofu", "dns.tf"), f"{dir}/main.tf", data)],
        dir=dir, env=credential_env(opts, "provider-dns"))


def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Green's cheshire JSON emits for
    floats: decimal between 1e-3 and 1e7, `d.dddE±e` scientific outside it.
    Python's own repr disagrees exactly where scientific notation starts
    (0.0001 -> "1.0E-4"), and the goldens carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"temporal": {"hosts": {
            utils.host_alias(opts): {
                "ansible_host": opts.get("ip") or "192.0.2.10",
                "ansible_user": "root"}}}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the converge stage. `ssh-private-key-path` reaches
    ansible.cfg so convergence uses the deployment's own key in keygen mode,
    where nothing guarantees an agent holds it. No firewall source reaches the
    play: the provider firewall is the load-bearing layer and the play manages
    no ufw (Compute Provider Standard §5)."""
    services = opts.get("temporal-services")
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-keygen": validate.keygen(opts),
            "temporal-services-csv": ",".join(
                str(s) for s in (services if isinstance(services, (list, tuple)) else []))}


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [spec(template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            spec(template("ansible", "main.yml"), f"{dir}/main.yml", data),
            spec(template("ansible", "cleanup.yml"), f"{dir}/cleanup.yml", data),
            spec(template("application", "package.json"),
                 f"{dir}/application/package.json", data),
            spec(template("application", "package-lock.json"),
                 f"{dir}/application/package-lock.json", data),
            spec(template("application", "tsconfig.json"),
                 f"{dir}/application/tsconfig.json", data),
            spec(template("application", "Dockerfile"),
                 f"{dir}/application/Dockerfile", data),
            spec(template("application/src", "activities.ts"),
                 f"{dir}/application/src/activities.ts", data),
            spec(template("application/src", "workflows.ts"),
                 f"{dir}/application/src/workflows.ts", data),
            spec(template("application/src", "index.ts"),
                 f"{dir}/application/src/index.ts", data),
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to clean up, and the rendered
        # inventory would fall back to 192.0.2.10. Remove the rendered tree the
        # way a completed cleanup would and let the teardown continue.
        return {**scaffold(opts, ansible_specs(opts)),
                "blue/exit": 0, "temporal/cleanup": "skipped-no-compute"}
    return await ansible_with_spec(opts, ansible_specs(opts),
                                   dir=dir, inventory="inventory.json",
                                   playbooks={"create": "main.yml", "delete": "cleanup.yml"},
                                   host_key_checking=False)


async def acceptance_step(opts: dict) -> dict:
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    url = f"https://{opts.get('reference-application-host')}/healthz"
    result = await runtime.exec(["curl", "--fail", "--silent", "--show-error",
                                 "--retry", "30", "--retry-delay", "5", url],
                                timeout_ms=180000)
    if result.exit == 0:
        return {**opts, "blue/exit": 0}
    return {**opts, "blue/exit": 1,
            "blue/err": f"public HTTPS health check failed: {result.err}"}
