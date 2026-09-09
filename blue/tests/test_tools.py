import json
from pathlib import Path

from blue.runtime import runtime
from blue.scaffold import render_template
from conftest import fixture, keygen
from package_temporal_blue import tools
from test_validate import valid

RESOURCES = Path(tools.__file__).parent / "resources"




def render_play(opts: dict) -> str:
    return render_template(tools.template("ansible", "main.yml"),
                           tools.ansible_data(opts), tools.template_opts)


async def test_delete_cleanup_skips_when_state_has_no_compute():
    # With the instance already gone the inventory would render 192.0.2.10;
    # there is no host to reach, so the step must not run the playbook and the
    # teardown must continue past it.
    original = runtime.exec

    async def must_not_run(cmd, **kwargs):
        raise AssertionError("playbook must not run")

    runtime.exec = must_not_run
    try:
        r = await tools.ansible_step({**valid, "blue/event": "delete"})
        assert r["blue/exit"] == 1
        assert r["blue/err"] == "compute node unavailable"
    finally:
        runtime.exec = original


async def test_delete_cleanup_targets_the_adopted_address(tmp_path):
    # When the start step recovered the instance address from state, the
    # cleanup playbook runs against it, never the documentation fallback.
    # The rendered tree is removed again after a successful cleanup, so the
    # inventory must be captured at the moment the playbook would run.
    original = runtime.exec
    captured = {}

    async def fake_exec(cmd, cwd=None, env=None, timeout_ms=None):
        if cmd[0] == "ansible-playbook":
            inventory = Path(tmp_path, "x", "temporal-ansible", "inventory.json")
            captured["inventory"] = inventory.read_text()
            captured["command"] = cmd

        class Result:
            exit = 0
            out = ""
            err = ""
        return Result()

    runtime.exec = fake_exec
    try:
        r = await tools.ansible_step({**valid, "workdir": str(tmp_path),
                                      "blue/event": "delete", "ip": "203.0.113.7", "user":"ubuntu"})
        assert r["blue/exit"] == 0
        assert "203.0.113.7" in captured["inventory"]
    finally:
        runtime.exec = original


def test_inventory_has_private_target():
    s = tools.inventory({"profile": "x", "ip": "192.0.2.1", "user":"ubuntu"})
    assert "temporal" in s
    assert "192.0.2.1" in s
    json.loads(s)










def test_the_provider_firewall_is_the_only_firewall():
    # Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
    # no firewall source reaches it.
    play = render_play(fixture())
    assert "ufw" not in play
    assert "127.0.0.1/32" not in play
    assert "ssh-source" not in tools.ansible_data(fixture())


def test_empty_http_sources_close_application_ingress():
    from package_temporal_blue import compute
    assert len(compute.requirements(fixture({'temporal-http-sources':[]}))['security']['ingress'])==1
