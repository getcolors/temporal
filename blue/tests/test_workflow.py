from package_temporal_blue import workflow
from test_validate import valid


def deletable_opts(**overrides):
    """Opts that pass real-delete preflight: guard lifted, secrets present."""
    return {**valid,
            "compute-prevent-destroy": False, "do-token": "t",
            "cloudflare-api-token": "t", "blue/event": "delete",
            **overrides}


async def test_delete_fails_loudly_when_state_is_unreadable():
    # Swallowing a failed state read is how a live teardown ended up pointing
    # the cleanup playbook at 192.0.2.10: stale backend credentials made
    # `tofu output` fail, nothing was merged, and the inventory fell back to
    # TEST-NET. The failure must surface here, before any playbook runs.
    async def unreadable(_opts, _dir):
        raise RuntimeError("Unauthorized")

    r = await workflow.start_step(deletable_opts(), {}, unreadable)
    assert r["blue/exit"] == 1
    assert "Unauthorized" in r["blue/err"]
    assert "COLORS_PAR_IP" in r["blue/err"]


async def test_delete_with_explicit_ip_skips_the_state_read():
    # COLORS_PAR_IP is the operator's escape hatch when the state backend is
    # unreachable; it must not require the read it exists to replace.
    async def must_not_be_called(_opts, _dir):
        raise RuntimeError("must not be called")

    r = await workflow.start_step(deletable_opts(ip="203.0.113.7"), {}, must_not_be_called)
    assert r["blue/exit"] == 0
    assert r["ip"] == "203.0.113.7"


async def test_delete_with_empty_state_proceeds_without_an_address():
    # State readable, no compute recorded: the instance is already gone, the
    # cleanup step skips itself, and the rest of the teardown still runs.
    async def empty(_opts, _dir):
        return None

    r = await workflow.start_step(deletable_opts(), {}, empty)
    assert r["blue/exit"] == 0
    assert r.get("ip") is None


def test_graph_order():
    assert workflow.wire_fn("temporal/start", {"blue/event": "create"})[1] == \
        "temporal/infrastructure"
    assert workflow.wire_fn("temporal/start", {"blue/event": "delete"})[1] == \
        "temporal/ansible"
    assert workflow.wire_fn("temporal/ansible", {"blue/event": "create"})[1] == \
        "temporal/acceptance"


async def test_profile_overlay_refused():
    r = await workflow.start_step({"blue/event": "build"}, {"COLORS_PAR_PROFILE": "other"})
    assert r["blue/exit"] == 2
