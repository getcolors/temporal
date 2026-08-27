terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}
provider "cloudflare" {}
data "cloudflare_zone" "domain" {
  filter = { name = "<{ cloudflare-zone }>" }
}
resource "cloudflare_dns_record" "application" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "<{ reference-application-host }>"
  content = "<{ ip }>"
  type    = "A"
  proxied = <{ cloudflare-proxied }>
  ttl     = 1
}
