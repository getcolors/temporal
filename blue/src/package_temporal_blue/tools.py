"""OpenTofu and Ansible stages for the single-machine Temporal stack, the port
of io.github.getcolors.temporal.tools."""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed

from . import utils, validate

infrastructure_tool = "temporal-infrastructure"
dns_tool = "temporal-dns"
ansible_tool = "temporal-ansible"

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


def cidrs(opts: dict, k: str) -> list[str]:
    v = opts.get(k)
    xs = v if isinstance(v, (list, tuple)) else re.split(r"[,\s]+", str(v))
    return [x for x in (str(item).strip() for item in xs) if x]


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


ZERO_FINGERPRINT = "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"


async def ssh_fingerprint(path) -> str:
    resolved = str(path).replace("~/", str(Path.home()) + "/")
    result = await runtime.exec(["ssh-keygen", "-E", "md5", "-lf", resolved])
    if result.exit != 0:
        return ZERO_FINGERPRINT
    match = re.search(r"(MD5:[0-9a-f:]+)", result.out)
    return match.group(1).replace("MD5:", "") if match else ZERO_FINGERPRINT


def fallback_params(opts: dict) -> dict:
    return {"ip": "192.0.2.10", "user": "root", "sudoer": "root",
            "name": opts.get("profile")}


async def infrastructure_data(opts: dict) -> dict:
    return {**opts,
            "digitalocean-ssh-key-fingerprint":
                (ZERO_FINGERPRINT if opts.get("blue/event") == "build"
                 else await ssh_fingerprint(opts.get("digitalocean-ssh-authorized-keys"))),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-sources")),
            "http-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-http-sources")),
            "https-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-https-sources"))}


def output_params(result: dict) -> dict | None:
    params = (result.get("tofu/outputs") or {}).get("params")
    return params if isinstance(params, dict) else None


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    data = await infrastructure_data(opts)
    specs = [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data)]
    result = await tofu.tofu_with_spec(opts, specs, dir=dir,
                                       env=credential_env(opts, "provider-compute"))
    if failed(result):
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return {**result, **fallback_params(opts), **(output_params(result) or {})}


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


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"temporal": {"hosts": {
            utils.host_alias(opts): {
                "ansible_host": opts.get("ip") or "192.0.2.10",
                "ansible_user": "root"}}}}}})


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    services = opts.get("temporal-services")
    data = {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-source": next(iter(cidrs(opts, "digitalocean-ssh-sources")), None),
            "temporal-services-csv": ",".join(
                str(s) for s in (services if isinstance(services, (list, tuple)) else []))}
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
