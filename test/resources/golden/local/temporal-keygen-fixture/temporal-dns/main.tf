terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}
provider "cloudflare" {}
data "cloudflare_zone" "domain" {
  filter = { name = "example.com" }
}
resource "cloudflare_dns_record" "application" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "example.com"
  content = "192.0.2.10"
  type    = "A"
  proxied = false
  ttl     = 1
}
