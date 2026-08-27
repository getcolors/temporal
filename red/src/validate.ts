// Desired-state and credential validation, the port of
// io.github.getcolors.temporal.validate. The compute and DNS credential maps
// are this package's own; the state-backend registry is ONCE's.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.

import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers as onceProviders } from "package-once-red";
import { provider } from "./utils.ts";

export const profilePar = parName("profile");

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy", "temporal-version", "temporal-services",
  "temporal-namespace", "temporal-retention-days", "temporal-typescript-sdk-version",
  "node-version", "postgres-version", "postgres-data-dir", "temporal-data-dir",
  "reference-application-host", "reference-application-port",
  "reference-workflow-delay-seconds", "reference-activity-failures",
  "reference-activity-maximum-attempts", "reference-duplicate-policy",
  "digitalocean-name", "digitalocean-region", "digitalocean-size",
  "digitalocean-image", "digitalocean-backups",
  "digitalocean-ssh-authorized-keys", "digitalocean-ssh-sources",
  "digitalocean-http-sources", "digitalocean-https-sources",
  "cloudflare-zone", "cloudflare-proxied", "tls-provider",
];

export function missing(x: unknown): boolean {
  return x == null || (typeof x === "string" && x.trim() === "");
}

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const versionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const forbiddenVpcKeys = [
  "digitalocean-vpc-id", "digitalocean-vpc-uuid",
  "digitalocean-vpc-cidr", "digitalocean-vpc-name",
];

function isInteger(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x);
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (opts["provider-compute"] !== "digitalocean") {
    errors.push(":provider-compute must be digitalocean");
  }
  if (provider(opts["provider-dns"]) !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be local, s3, or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  if (typeof opts["digitalocean-backups"] !== "boolean") {
    errors.push(":digitalocean-backups must be true or false");
  }
  if (!versionRe.test(String(opts["temporal-version"]))) {
    errors.push(":temporal-version must be an exact x.y.z version");
  }
  if (!versionRe.test(String(opts["temporal-typescript-sdk-version"]))) {
    errors.push(":temporal-typescript-sdk-version must be an exact x.y.z version");
  }
  const services = opts["temporal-services"];
  if (!(Array.isArray(services) &&
        JSON.stringify(services) === JSON.stringify(["frontend", "history", "matching", "worker"]))) {
    errors.push(":temporal-services must contain frontend, history, matching, and worker in that order");
  }
  if (opts["reference-duplicate-policy"] !== "reject") {
    errors.push(":reference-duplicate-policy must be reject");
  }
  const failures = opts["reference-activity-failures"];
  const attempts = opts["reference-activity-maximum-attempts"];
  if (!(isInteger(failures) && isInteger(attempts) &&
        0 < (failures as number) && (failures as number) < (attempts as number))) {
    errors.push(":reference-activity-maximum-attempts must exceed a positive :reference-activity-failures");
  }
  if (!hostRe.test(String(opts["reference-application-host"]))) {
    errors.push(":reference-application-host must be a fully qualified hostname");
  }
  if (opts["reference-application-host"] !== opts["cloudflare-zone"]) {
    errors.push(":reference-application-host must be the Cloudflare zone apex");
  }
  if (opts["digitalocean-region"] !== "ams3") {
    errors.push(":digitalocean-region must be the configured Amsterdam region ams3");
  }
  for (const key of forbiddenVpcKeys) {
    if (key in opts) {
      errors.push(`:${key} must not be configured; the default regional VPC is discovered at runtime`);
    }
  }
  return errors;
}

interface BackendEntry {
  secrets?: string[];
  tofuEnv?: Record<string, string>;
}

function backendEntry(opts: Opts): BackendEntry | undefined {
  return (onceProviders as Record<string, Record<string, BackendEntry>>)["provider-backend"]?.[
    String(opts["provider-backend"])];
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  if (slot === "provider-compute") return { "do-token": "DIGITALOCEAN_TOKEN" };
  if (slot === "provider-dns") return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
  if (slot === "provider-backend") return backendEntry(opts)?.tofuEnv ?? {};
  return {};
}

export function secretErrors(opts: Opts): string[] {
  const keys = ["do-token", "cloudflare-api-token", ...(backendEntry(opts)?.secrets ?? [])];
  return [...new Set(keys)]
    .filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}
