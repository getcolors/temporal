import json
from pathlib import Path

from blue.runtime import runtime
from blue.scaffold import render_template
from conftest import fixture, keygen
from package_temporal_blue import tools
from test_validate import valid

RESOURCES = Path(tools.__file__).parent / "resources"


def render_infrastructure(opts: dict) -> str:
    """The compute template for `opts`' provider, rendered as `build` would."""
    return render_template(tools.template(f"infrastructure.{opts['provider-compute']}", "main.tf"),
                           tools.infrastructure_data(opts), tools.template_opts)


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


def test_infrastructure_renders_two_ingress_groups():
    # Formerly three: 443 now follows `digitalocean-http-sources` (Compute
    # Provider Standard §5) and `digitalocean-https-sources` is not read.
    data = tools.infrastructure_data(fixture({
        "blue/event": "build",
        "digitalocean-ssh-sources": ["1.2.3.4/32"],
        "digitalocean-http-sources": ["0.0.0.0/0"],
        "digitalocean-https-sources": ["198.51.100.0/24"]}))
    assert "1.2.3.4/32" in data["ssh-sources-hcl"]
    assert "0.0.0.0/0" in data["http-sources-hcl"]
    assert "https-sources-hcl" not in data
    assert "198.51.100.0/24" not in render_infrastructure(
        fixture({"digitalocean-https-sources": ["198.51.100.0/24"]}))


def test_infrastructure_data_carries_the_name_and_the_keypair_mode():
    # One resolved name and one mode reach every template; no fingerprint is
    # shelled out for: the key model is the standard's.
    optout = tools.infrastructure_data(fixture())
    assert optout["compute-name"] == "temporal-fixture"
    assert optout["ssh-keygen"] is False
    assert "digitalocean-ssh-key-fingerprint" not in optout
    generated = tools.infrastructure_data(keygen())
    assert generated["compute-name"] == "temporal-keygen-fixture"
    assert generated["ssh-keygen"] is True
    assert tools.ansible_data(keygen())["ssh-keygen"] is True
    assert tools.ansible_data(fixture())["ssh-keygen"] is False


def test_the_template_names_the_machine_from_one_resolved_value():
    template = (RESOURCES / "tools/infrastructure/digitalocean/main.tf").read_text()
    assert "<{ digitalocean-name }>" not in template
    assert 'name     = "<{ compute-name }>"' in template
    assert 'name        = "<{ compute-name }>-firewall"' in template
    assert 'provider = "digitalocean"' in template
    assert "https-sources" not in template
    rendered = render_infrastructure(fixture({"digitalocean-name": "custom-label"}))
    assert 'name     = "custom-label"' in rendered
    assert 'name        = "custom-label-firewall"' in rendered
    assert 'name = "custom-label"' in rendered


def test_keygen_mode_declares_the_key_resource_and_opt_out_keeps_the_literal():
    generated = render_template(
        tools.template("infrastructure.digitalocean", "main.tf"),
        {**tools.infrastructure_data(keygen()),
         "ssh-public-key-path": "/home/build-placeholder/.ssh/temporal-keygen-fixture.pub"},
        tools.template_opts)
    assert 'resource "digitalocean_ssh_key" "machine"' in generated
    assert 'name       = "temporal-keygen-fixture"' in generated
    assert "ssh_keys = [digitalocean_ssh_key.machine.id]" in generated
    assert "ssh_key_id = digitalocean_ssh_key.machine.id" in generated
    assert "digitalocean_ssh_keys" not in generated
    optout = render_infrastructure(fixture())
    assert "digitalocean_ssh_key" not in optout
    assert 'ssh_keys = ["00000000"]' in optout
    assert "ssh_key_id" not in optout


def test_the_provider_firewall_is_the_only_firewall():
    # Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
    # no firewall source reaches it.
    play = render_play(fixture())
    assert "ufw" not in play
    assert "127.0.0.1/32" not in play
    assert "ssh-source" not in tools.ansible_data(fixture())


def test_empty_http_sources_renders_no_public_http():
    # The 80/443 rules are a dynamic block over an empty list, because
    # DigitalOcean rejects an inbound rule with no source as an API error
    # rather than a closed port. SSH stays.
    empty = render_infrastructure(fixture({"digitalocean-http-sources": []}))
    assert "length([]) > 0 ? [" in empty
    assert "source_addresses = []" in empty
    assert 'port_range       = "22"' in empty
    full = render_infrastructure(fixture())
    assert 'length(["0.0.0.0/0", "::/0"]) > 0 ? [' in full
    assert '{ protocol = "tcp", port_range = "443" }' in full
    assert 'udp", port_range' not in full


def test_a_missing_compute_output_fails_loudly():
    assert tools.resolved_compute({}, {"ip": "192.0.2.10"}, {"ip": "1.2.3.4"})["ip"] == "1.2.3.4"
    assert tools.resolved_compute({}, {"ip": "192.0.2.10"}, None)["blue/exit"] == 1
    assert "compute produced no ip output" in \
        tools.resolved_compute({}, {"ip": "192.0.2.10"}, {})["blue/err"]
    assert tools.fallback_params(fixture())["provider"] == "digitalocean"
