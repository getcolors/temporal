from blue.cli import par_name
from conftest import fixture, keygen
from package_temporal_blue import validate

# The historical inline valid map, kept so the older tests read as they did.
valid = fixture({"profile": "x", "digitalocean-name": "x", "digitalocean-image": "ubuntu",
                 "digitalocean-ssh-sources": ["1.2.3.4/32"],
                 "digitalocean-http-sources": ["0.0.0.0/0"]})


def test_validates_complete_state():
    assert validate.state_errors(valid) == []
    assert validate.state_errors(fixture()) == []
    assert validate.state_errors(keygen()) == []


def test_reports_all_errors():
    # The `digitalocean-region: nyc3` override no longer counts: the hardcoded
    # ams3 check went with the Compute Provider Standard (the registry
    # requires presence only), so an empty SSH list takes its place.
    opts = {k: v for k, v in valid.items() if k != "profile"}
    errors = validate.state_errors({**opts, "provider-dns": "bad",
                                    "digitalocean-region": "nyc3",
                                    "digitalocean-ssh-sources": [],
                                    "digitalocean-vpc-id": "invented"})
    assert len(errors) >= 3
    assert not any("ams3" in e for e in errors)


def test_validates_secrets():
    assert validate.secret_errors(valid) == [
                "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
        "required credential is not set: COLORS_PAR_R2_ACCESS_KEY_ID",
        "required credential is not set: COLORS_PAR_R2_SECRET_ACCESS_KEY",
    ]


def test_refuses_profile_overlay():
    assert validate.env_errors({par_name("profile"): "other"})


# --- the spec handed to ONCE




# --- the compute-provider registry




def test_region_is_required_but_not_pinned():
    assert validate.state_errors(fixture({"digitalocean-region": "nyc3"})) == []
    assert "invalid compute deployment requirements" in \
        validate.state_errors(fixture({"digitalocean-region": None}))




def test_legacy_alias_conflicts_are_refused():
    assert validate.state_errors(fixture({'digitalocean-ssh-authorized-keys':'~/.ssh/id_ed25519.pub'}))
    assert validate.state_errors(fixture({'digitalocean-https-sources':['0.0.0.0/0']})) == []


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(keygen())
    assert not validate.keygen(fixture())
    # Absence, not a flag, is the switch.
    assert validate.keygen(fixture({"digitalocean-ssh-keys": None, "ssh-private-key-path": None}))






# --- the network contract, wired through state_errors with ONCE's messages






# --- provider checks




def test_backups_must_be_a_boolean():
    assert "invalid compute deployment requirements" in \
        validate.state_errors(fixture({"digitalocean-backups": "yes"}))


def test_keeps_the_packages_own_checks():
    assert any("in that order" in e for e in validate.state_errors(
        fixture({"temporal-services": ["worker", "frontend", "history", "matching"]})))
    assert any("zone apex" in e for e in validate.state_errors(
        fixture({"reference-application-host": "api.example.com"})))
