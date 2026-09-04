terraform {
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}
provider "digitalocean" {}

# Looking up by region returns that region's existing default VPC. The
# deployment neither creates a VPC nor accepts a VPC identifier as input.
data "digitalocean_vpc" "default" { region = "ams3" }

resource "digitalocean_droplet" "temporal" {
  name     = "temporal-fixture"
  region   = "ams3"
  size     = "c-8"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = ["00000000"]
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
  # 80 and 443 from the HTTP sources, and nothing else. A rule with no source
  # is not "closed" to DigitalOcean but an API error, so the HTTP rules are
  # emitted only when there is a source to name; an empty http-sources list
  # means no public HTTP at all.
  dynamic "inbound_rule" {
    for_each = length(["0.0.0.0/0", "::/0"]) > 0 ? [
      { protocol = "tcp", port_range = "80" },
      { protocol = "tcp", port_range = "443" },
    ] : []
    content {
      protocol         = inbound_rule.value.protocol
      port_range       = inbound_rule.value.port_range
      source_addresses = ["0.0.0.0/0", "::/0"]
    }
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
  value = { provider = "digitalocean", ip = digitalocean_droplet.temporal.ipv4_address, user = "root", sudoer = "root", name = "temporal-fixture" }
}
