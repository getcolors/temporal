import json
from pathlib import Path

from blue.runtime import runtime
from package_temporal_blue import tools
from test_validate import valid


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
        assert r["blue/exit"] == 0
        assert r["temporal/cleanup"] == "skipped-no-compute"
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
                                      "blue/event": "delete", "ip": "203.0.113.7"})
        assert r["blue/exit"] == 0
        assert "203.0.113.7" in captured["inventory"]
    finally:
        runtime.exec = original


def test_inventory_has_private_target():
    s = tools.inventory({"profile": "x", "ip": "192.0.2.1"})
    assert "temporal" in s
    assert "192.0.2.1" in s
    json.loads(s)


async def test_infrastructure_renders_three_ingress_groups():
    data = await tools.infrastructure_data(
        {"blue/event": "build", "digitalocean-ssh-authorized-keys": "x",
         "digitalocean-ssh-sources": ["1.2.3.4/32"],
         "digitalocean-http-sources": ["0.0.0.0/0"],
         "digitalocean-https-sources": ["0.0.0.0/0"]})
    assert "1.2.3.4/32" in data["ssh-sources-hcl"]
    assert "0.0.0.0/0" in data["http-sources-hcl"]
