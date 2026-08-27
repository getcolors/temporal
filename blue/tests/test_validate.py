from blue.cli import par_name
from package_temporal_blue import validate

valid = {
    "profile": "x", "workdir": ".colors", "provider-compute": "digitalocean",
    "provider-dns": "cloudflare", "provider-backend": "local",
    "compute-prevent-destroy": True,
    "temporal-version": "1.31.2",
    "temporal-services": ["frontend", "history", "matching", "worker"],
    "temporal-namespace": "benchmark", "temporal-retention-days": 7,
    "temporal-typescript-sdk-version": "1.22.0", "node-version": 22,
    "postgres-version": 17,
    "postgres-data-dir": "/data/postgresql", "temporal-data-dir": "/data/temporal",
    "reference-application-host": "example.com", "reference-application-port": 3000,
    "reference-workflow-delay-seconds": 120, "reference-activity-failures": 2,
    "reference-activity-maximum-attempts": 5, "reference-duplicate-policy": "reject",
    "digitalocean-name": "x", "digitalocean-region": "ams3", "digitalocean-size": "c-8",
    "digitalocean-image": "ubuntu", "digitalocean-backups": True,
    "digitalocean-ssh-authorized-keys": "~/.ssh/id.pub",
    "digitalocean-ssh-sources": ["1.2.3.4/32"],
    "digitalocean-http-sources": ["0.0.0.0/0"],
    "digitalocean-https-sources": ["0.0.0.0/0"],
    "cloudflare-zone": "example.com", "cloudflare-proxied": False,
    "tls-provider": "letsencrypt",
}


def test_validates_complete_state():
    assert validate.state_errors(valid) == []


def test_reports_all_errors():
    opts = {k: v for k, v in valid.items() if k != "profile"}
    errors = validate.state_errors({**opts, "provider-dns": "bad",
                                    "digitalocean-region": "nyc3",
                                    "digitalocean-vpc-id": "invented"})
    assert len(errors) >= 4


def test_validates_secrets():
    assert validate.secret_errors(valid) == [
        "required credential is not set: COLORS_PAR_DO_TOKEN",
        "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
    ]


def test_refuses_profile_overlay():
    assert validate.env_errors({par_name("profile"): "other"})
