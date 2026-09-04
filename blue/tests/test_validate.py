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
    assert len(errors) >= 4
    assert not any("ams3" in e for e in errors)


def test_validates_secrets():
    assert validate.secret_errors(valid) == [
        "required credential is not set: COLORS_PAR_DO_TOKEN",
        "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
    ]


def test_refuses_profile_overlay():
    assert validate.env_errors({par_name("profile"): "other"})


# --- the spec handed to ONCE


def test_the_spec_carries_this_packages_registry_sources_and_default():
    # The operations are ONCE's; this is the data they run over. A colour
    # whose registry, sources or default drifts fails here, in that colour.
    assert list(validate.spec["registry"]) == ["digitalocean"]
    assert validate.spec["registry"] is validate.compute_providers
    assert validate.spec["registry"]["digitalocean"] == {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-backups", "digitalocean-ssh-sources",
                     "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    }
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources"],
                                        "may_be_empty": ["http-sources"]}
    # DigitalOcean: the default is what a legacy state without
    # params.provider is, and every deployment this package made ran there.
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["default"] == validate.default_compute_provider
    assert "name_rules" not in validate.spec, "the name rules are ONCE's"


# --- the compute-provider registry


def test_compute_provider_must_be_one_the_package_has_a_template_for():
    assert ":provider-compute must be one of digitalocean" in \
        validate.state_errors(fixture({"provider-compute": "vultr"}))


def test_region_is_required_but_not_pinned():
    assert validate.state_errors(fixture({"digitalocean-region": "nyc3"})) == []
    assert ":digitalocean-region is required" in \
        validate.state_errors(fixture({"digitalocean-region": None}))


def test_name_and_machine_key_are_never_required():
    for key in validate.compute_providers["digitalocean"]["required"]:
        assert not key.endswith("-name"), key
        assert not key.endswith("-ssh-keys"), key
    assert validate.state_errors(
        fixture({"digitalocean-name": None, "digitalocean-ssh-keys": None})) == []


def test_retired_keys_are_accepted_and_ignored():
    # `digitalocean-ssh-authorized-keys` (the pre-standard fingerprint path)
    # and `digitalocean-https-sources` (443 now follows http-sources) are
    # neither required nor read; a colors.yml that still carries them
    # validates, and absence of the retired key is not what selects keygen.
    assert validate.state_errors(fixture({
        "digitalocean-ssh-authorized-keys": "~/.ssh/id_ed25519.pub",
        "digitalocean-https-sources": ["0.0.0.0/0"]})) == []
    assert validate.state_errors(fixture({"digitalocean-ssh-authorized-keys": "x",
                                          "digitalocean-ssh-keys": None})) == []
    assert not validate.keygen(fixture({"digitalocean-ssh-authorized-keys": None}))


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(keygen())
    assert not validate.keygen(fixture())
    # Absence, not a flag, is the switch.
    assert validate.keygen(fixture({"digitalocean-ssh-keys": None}))


def test_compute_name_falls_back_to_the_profile():
    assert validate.compute_name(fixture()) == "temporal-fixture"
    assert validate.compute_name(keygen()) == "temporal-keygen-fixture"
    assert validate.compute_name(fixture({"digitalocean-name": "custom"})) == "custom"
    assert validate.compute_key(fixture(), "ssh-sources") == "digitalocean-ssh-sources"


def test_compute_credentials_follow_the_provider():
    assert validate.tofu_env(fixture(), "provider-compute") == \
        {"do-token": "DIGITALOCEAN_TOKEN"}
    assert validate.tofu_env(fixture({"provider-compute": "vultr"}), "provider-compute") == {}


# --- the network contract, wired through state_errors with ONCE's messages


def test_ssh_sources_must_not_be_empty():
    assert ":digitalocean-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": []}))
    assert validate.state_errors(fixture({"digitalocean-http-sources": []})) == []


def test_malformed_sources_are_refused_before_any_provider_call():
    assert ':digitalocean-ssh-sources entry "nope" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": ["0.0.0.0/0", "nope"]}))
    assert ':digitalocean-http-sources entry "203.0.113.0" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-http-sources": ["203.0.113.0"]}))
    assert validate.state_errors(
        fixture({"digitalocean-ssh-sources": ["2001:db8::/32", "203.0.113.4/32"]})) == []


# --- provider checks


def test_forbids_vpc_configuration():
    # ONCE's two and this package's two.
    assert any("vpc-uuid" in e for e in
               validate.state_errors(fixture({"digitalocean-vpc-uuid": "forbidden"})))
    assert any("must be absent" in e for e in
               validate.state_errors(fixture({"digitalocean-vpc-cidr": "10.0.0.0/16"})))
    assert (":digitalocean-vpc-id must not be configured; the default regional VPC"
            " is discovered at runtime") in \
        validate.state_errors(fixture({"digitalocean-vpc-id": "invented"}))
    assert any("vpc-name" in e for e in
               validate.state_errors(fixture({"digitalocean-vpc-name": "invented"})))


def test_backups_must_be_a_boolean():
    assert ":digitalocean-backups must be true or false" in \
        validate.state_errors(fixture({"digitalocean-backups": "yes"}))


def test_keeps_the_packages_own_checks():
    assert any("in that order" in e for e in validate.state_errors(
        fixture({"temporal-services": ["worker", "frontend", "history", "matching"]})))
    assert any("zone apex" in e for e in validate.state_errors(
        fixture({"reference-application-host": "api.example.com"})))
