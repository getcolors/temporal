terraform {
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}
provider "digitalocean" {}

data "digitalocean_ssh_keys" "operator" {
  filter {
    key    = "fingerprint"
    values = ["00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"]
  }
}

# Looking up by region returns that region's existing default VPC. The
# deployment neither creates a VPC nor accepts a VPC identifier as input.
data "digitalocean_vpc" "default" { region = "ams3" }

resource "digitalocean_droplet" "temporal" {
  name     = "temporal-fixture"
  region   = "ams3"
  size     = "c-8"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = [one(data.digitalocean_ssh_keys.operator.ssh_keys).id]
  backups  = true
  lifecycle { prevent_destroy = true }
}

resource "digitalocean_firewall" "temporal" {
  name        = "temporal-fixture-firewall"
  droplet_ids = [digitalocean_droplet.temporal.id]
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["127.0.0.1/32"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
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
  lifecycle { prevent_destroy = true }
}

output "params" {
  value = { ip = digitalocean_droplet.temporal.ipv4_address, user = "root", sudoer = "root", name = "temporal-fixture" }
}
