terraform {
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}
provider "digitalocean" {}

data "digitalocean_ssh_keys" "operator" {
  filter {
    key    = "fingerprint"
    values = ["<{ digitalocean-ssh-key-fingerprint }>"]
  }
}

# Looking up by region returns that region's existing default VPC. The
# deployment neither creates a VPC nor accepts a VPC identifier as input.
data "digitalocean_vpc" "default" { region = "<{ digitalocean-region }>" }

resource "digitalocean_droplet" "temporal" {
  name     = "<{ digitalocean-name }>"
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = [one(data.digitalocean_ssh_keys.operator.ssh_keys).id]
  backups  = <{ digitalocean-backups }>
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

resource "digitalocean_firewall" "temporal" {
  name        = "<{ digitalocean-name }>-firewall"
  droplet_ids = [digitalocean_droplet.temporal.id]
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = <{ ssh-sources-hcl|safe }>
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = <{ http-sources-hcl|safe }>
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = <{ https-sources-hcl|safe }>
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

output "params" {
  value = { ip = digitalocean_droplet.temporal.ipv4_address, user = "root", sudoer = "root", name = "<{ profile }>" }
}
