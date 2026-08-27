"""Lifecycle graph and backend advice, the port of
io.github.getcolors.temporal.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow

from . import tools, validate

DEFAULTS = {"provider-compute": "digitalocean", "provider-dns": "cloudflare",
            "provider-backend": "local", "compute-prevent-destroy": True,
            "workdir": ".colors"}

LIFECYCLE_EVENTS = ("create", "delete")


async def state_output(opts: dict, dir: str) -> dict | None:
    """Compute params recorded in the infrastructure state; None when the state
    holds none. An unreadable backend raises — the delete path treats that as
    fatal rather than falling back to the documentation address."""
    outputs = await tofu.outputs(dir, tools.backend_credential_env(opts))
    params = outputs.get("params")
    return params if isinstance(params, dict) else None


async def adopt_state(opts: dict, read_state=None) -> dict:
    """A real delete runs the ansible cleanup before the infrastructure step, so
    the instance address must come out of the existing state here. An explicit
    `ip` (COLORS_PAR_IP) skips the read; a readable state without compute params
    leaves `ip` unset and the cleanup step skips itself; an unreadable backend
    fails loudly — swallowing it is how a live teardown ended up converging
    against 192.0.2.10."""
    read_state = read_state or state_output
    if opts.get("ip"):
        return {**opts, "blue/exit": 0}
    try:
        params = await read_state(opts, tools.tool_dir(opts, tools.infrastructure_tool))
        return {**opts, **(params or {}), "blue/exit": 0}
    except Exception as e:  # noqa: BLE001 — the message is the mechanism
        return {**opts, "blue/exit": 1,
                "blue/err": ("could not read the infrastructure state for "
                             f"the delete cleanup: {e}\n"
                             "fix the backend credentials, or supply "
                             f"{par_name('ip')} to address the instance directly")}


async def start_step(opts: dict, env: dict | None = None, read_state=None) -> dict:
    async def after_validate(current, _environment, context):
        if context["real"] and context["event"] == "delete":
            return await adopt_state(current, read_state)
        return {**current, "blue/exit": 0}

    return await preflight(
        opts, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] in LIFECYCLE_EVENTS else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after_validate)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "temporal/start": (start_step, "temporal/ansible"),
            "temporal/ansible": (tools.ansible_step, "temporal/dns"),
            "temporal/dns": (tools.dns_step, "temporal/infrastructure"),
            "temporal/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    return {
        "temporal/start": (start_step, "temporal/infrastructure"),
        "temporal/infrastructure": (tools.infrastructure_step, "temporal/dns"),
        "temporal/dns": (tools.dns_step, "temporal/ansible"),
        "temporal/ansible": (tools.ansible_step, "temporal/acceptance"),
        "temporal/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


side_effecting = ["temporal/infrastructure", "temporal/dns",
                  "temporal/ansible", "temporal/acceptance"]


def create_workflow():
    wf = workflow(start="temporal/start", wire_fn=wire_fn)
    wf = advice_add(wf, "temporal/infrastructure", "before",
                    "io.github.getcolors.temporal.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "temporal/dns", "before",
                    "io.github.getcolors.temporal.workflow/backend",
                    backend_advice(tools.dns_tool))
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting)
    return wf


temporal_workflow = create_workflow()
