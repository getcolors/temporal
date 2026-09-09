"""The graph, the port of io.github.getcolors.temporal.workflow."""

from __future__ import annotations

import os

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from . import compute

from . import ssh, ssh_config, tools, validate

DEFAULTS = {"provider-compute": validate.default_compute_provider,
            "provider-dns": "cloudflare",
            "provider-backend": "r2", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def start_step(original, env=None):
    async def after(opts, environment, ctx):
        if ctx['real'] and ctx['event'] == 'delete':
            result = await compute.load(opts, environment)
            return {**result, "ip": opts["ip"]} if not failed(result) and opts.get("ip") and not result.get("temporal/already-destroyed") else result
        if ctx['real'] and ctx['event'] == 'create':
            return ssh_config.preflight(opts)
        return {**ssh.with_machine_key(opts), 'blue/exit': 0}
    return await preflight(original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[lambda _o,e,_c: validate.env_errors(e), lambda o,_e,_c: validate.state_errors(o),
                    lambda o,_e,c: validate.secret_errors(o) if c['real'] and c['event'] in ('create','delete') else [],
                    lambda o,_e,c: ['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false to delete'] if c['real'] and c['event']=='delete' and o.get('compute-prevent-destroy') else []], after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "temporal/start": (start_step, "temporal/ansible"),
            "temporal/ansible": (tools.ansible_step, "temporal/dns"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its host is stale but
            # harmless; a key that predeceases its host locks the operator out
            # of a machine that still exists. Both orders are deliberate; see
            # standards/ssh-config.md.
            "temporal/dns": (tools.dns_step, "temporal/ssh-config"),
            "temporal/ssh-config": (tools.ansible_local_step, "temporal/infrastructure"),
            "temporal/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    return {
        "temporal/start": (start_step, "temporal/infrastructure"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine.
        "temporal/infrastructure": (tools.infrastructure_step, "temporal/ssh-config"),
        "temporal/ssh-config": (tools.ansible_local_step, "temporal/dns"),
        "temporal/dns": (tools.dns_step, "temporal/ansible"),
        "temporal/ansible": (tools.ansible_step, "temporal/acceptance"),
        "temporal/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile') or ''}/{tool}.tfstate")


side_effecting = ["temporal/infrastructure", "temporal/dns", "temporal/ssh-config",
                  "temporal/ansible", "temporal/acceptance"]


def create_workflow():
    wf = workflow(start="temporal/start", wire_fn=wire_fn, next_fn=lambda _step, successors, opts: [] if opts.get("temporal/already-destroyed") or failed(opts) else [(step, opts) for step in (successors or [])])
    wf = advice_add(wf, "temporal/dns", "before", "temporal.workflow/backend",
                    backend_advice(tools.dns_tool))
    return dry_run.advise(progress.advise(wf), side_effecting)


temporal_workflow = create_workflow()
