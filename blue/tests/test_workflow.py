import pytest
from blue.workflow import StepError
from conftest import fixture, keygen
from package_temporal_blue import workflow
from test_validate import valid

# The compute state is read once per run, through `state_output`, on a real
# create or delete. Every lifecycle test stubs it: None is a readable state
# holding no compute, a dict is a recorded `params`, and a raise is a backend
# that cannot be read.


@pytest.fixture
def state(monkeypatch):
    def install(params):
        async def stub(_opts):
            return params
        monkeypatch.setattr(workflow, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    def install(message="tofu output failed: no backend"):
        async def boom(_opts):
            raise StepError(message)
        monkeypatch.setattr(workflow, "state_output", boom)
    install()
    return install


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Redirect `~/.ssh` for the paths that fill the real key paths."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def deletable_opts(**overrides):
    """Opts that pass real-delete preflight: guard lifted, secrets present."""
    return {**valid,
            "compute-prevent-destroy": False, "do-token": "t",
            "cloudflare-api-token": "t", "blue/event": "delete",
            **overrides}


async def test_build_and_dry_run_need_no_credentials():
    assert (await workflow.start_step({**fixture(), "blue/event": "build"}, env={}))["blue/exit"] == 0
    assert (await workflow.start_step(
        {**fixture(), "blue/event": "create", "blue/dry-run": True}, env={}))["blue/exit"] == 0


async def test_build_and_dry_run_never_touch_ssh_or_state(unreadable):
    # The standard forbids reading, creating, or requiring anything under
    # ~/.ssh on a build or dry-run: they render from desired state alone. Nor
    # do they read the backend: a raising state read proves nothing on these
    # paths reaches it.
    for opts in [{**keygen(), "blue/event": "build"},
                 {**keygen(), "blue/event": "create", "blue/dry-run": True},
                 {**keygen(), "blue/event": "delete", "blue/dry-run": True}]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert str(result["ssh-public-key-path"]).startswith("/home/build-placeholder"), \
            "a build must not name the operator's home directory"


async def test_real_create_requires_credentials(state):
    state(None)
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_CLOUDFLARE_API_TOKEN" in result["blue/err"]


async def test_delete_is_protected(state):
    state(None)
    result = await workflow.start_step({**fixture(), "blue/event": "delete"}, env={})
    assert result["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in result["blue/err"]


# --- provider switching is a rebuild, never an apply


async def test_a_provider_switch_is_refused_on_create_and_delete(state):
    for event in ["create", "delete"]:
        state({"provider": "vultr", "ip": "203.0.113.9"})
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert result["blue/exit"] == 2, event
        assert ("state holds a vultr machine; set provider-compute back to vultr "
                "and delete first") in result["blue/err"]
        # The validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected.
        assert "required credential is not set" not in result["blue/err"]


async def test_legacy_state_is_accepted_on_digitalocean(state):
    # A state recorded before this package wrote params.provider is a
    # DigitalOcean machine's -- every temporal deployment ran there.
    state({"ip": "203.0.113.9"})
    for event in ["create", "delete"]:
        result = await workflow.start_step(
            {**fixture(), "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert "state holds" not in result["blue/err"], event
        assert "required credential is not set" in result["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state({"provider": "digitalocean", "ip": "203.0.113.9"})
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # A fresh clone has no readable state and must still be able to create.
    result = await workflow.start_step({**fixture(), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "could not read" not in result["blue/err"]
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # No state stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. The SDK's output read
    # raises its StepError there, which ONCE's `read_state` counts as an
    # unreadable state, so the create reports its credentials.
    result = await workflow.start_step(
        {**fixture(), "workdir": str(tmp_path), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


async def test_delete_fails_loudly_when_state_is_unreadable(unreadable):
    # Swallowing a failed state read is how a live teardown ended up pointing
    # the cleanup playbook at 192.0.2.10. The failure must surface here, with
    # ONCE's wording (the old message named COLORS_PAR_IP as a way round the
    # read; the override no longer skips it, so the message no longer offers it).
    unreadable("Unauthorized")
    result = await workflow.start_step(deletable_opts(), env={})
    assert result["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in result["blue/err"]
    assert "Unauthorized" in result["blue/err"]


async def test_delete_with_explicit_ip_overrides_the_adopted_address_after_the_read(
        state, unreadable, home):
    # COLORS_PAR_IP replaces a stale recorded address; it never skips the read
    # or the provider guard (it used to skip the read -- that changed). On a
    # readable state the override wins over the recorded address; an
    # unreadable backend still fails closed with it set.
    state({"provider": "digitalocean", "ip": "198.51.100.1", "user": "root"})
    adopted = await workflow.start_step(deletable_opts(ip="203.0.113.7"), env={})
    assert adopted["blue/exit"] == 0
    assert adopted["ip"] == "203.0.113.7"
    unreadable()
    result = await workflow.start_step(deletable_opts(ip="203.0.113.7"), env={})
    assert result["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in result["blue/err"]


async def test_delete_with_empty_state_proceeds_without_an_address(state, home):
    # State readable, no compute recorded: the instance is already gone, the
    # cleanup step skips itself, and the rest of the teardown still runs.
    state(None)
    result = await workflow.start_step(deletable_opts(), env={})
    assert result["blue/exit"] == 0
    assert result.get("ip") is None


async def test_a_real_delete_adopts_the_recorded_address(state, home):
    state({"provider": "digitalocean", "ip": "203.0.113.9", "user": "root"})
    result = await workflow.start_step(deletable_opts(), env={})
    assert result["blue/exit"] == 0
    assert result["ip"] == "203.0.113.9"


def test_graph_order():
    create = {"blue/event": "create"}
    assert workflow.wire_fn("temporal/start", create)[1] == "temporal/infrastructure"
    assert workflow.wire_fn("temporal/infrastructure", create)[1] == "temporal/ssh-config"
    assert workflow.wire_fn("temporal/ssh-config", create)[1] == "temporal/dns"
    assert workflow.wire_fn("temporal/dns", create)[1] == "temporal/ansible"
    assert workflow.wire_fn("temporal/ansible", create)[1] == "temporal/acceptance"
    assert workflow.wire_fn("temporal/start", {"blue/event": "delete"})[1] == "temporal/ansible"


def test_delete_removes_the_config_block_before_the_destroy_and_the_key_after_it():
    delete = {"blue/event": "delete"}
    assert workflow.wire_fn("temporal/ansible", delete)[1:] == ("temporal/dns",)
    assert workflow.wire_fn("temporal/dns", delete)[1:] == ("temporal/ssh-config",)
    assert workflow.wire_fn("temporal/ssh-config", delete)[1:] == ("temporal/infrastructure",)
    assert workflow.wire_fn("temporal/infrastructure", delete)[1:] == ("temporal/ssh-cleanup",)
    assert workflow.wire_fn("temporal/ssh-cleanup", delete)[1:] == ()
    assert "temporal/ssh-config" in workflow.side_effecting
    assert "temporal/ssh-cleanup" in workflow.side_effecting


async def test_profile_overlay_refused():
    r = await workflow.start_step({"blue/event": "build"}, {"COLORS_PAR_PROFILE": "other"})
    assert r["blue/exit"] == 2
