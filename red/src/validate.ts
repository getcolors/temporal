// Desired-state and credential validation, the port of
// io.github.getcolors.temporal.validate. The compute registry, the spec and
// the DNS credential map are this package's own; the operations over the
// registry are ONCE's `compute`, and the state-backend registry is ONCE's.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.

import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { compute, providers as onceProviders } from "package-once-red";
import { onceSsh } from "./once.ts";
import { provider } from "./utils.ts";

export const profilePar = parName("profile");

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

// provider-compute -> what that choice implies (Compute Provider Standard §2).
//
// `required` are the non-secret keys that provider's template interpolates,
// `secrets` the credentials it needs through COLORS_PAR_*, and `tofuEnv` the
// subset OpenTofu reads from the process environment itself. Keeping the three
// together is what stops a provider being validated against one set of keys
// and run with another. The keys of this map are the advertised providers; a
// provider without a template directory and a golden is not advertised, and
// this package advertises one.
//
// Two keys the template reads are deliberately not required.
// `digitalocean-name` is an optional override of the profile (Compute Name
// Standard), and `digitalocean-ssh-keys` is meaningful by its absence (SSH
// Keypair Standard).
export const computeProviders: compute.Registry = {
  digitalocean: {
    required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
               "digitalocean-backups", "digitalocean-ssh-sources",
               "digitalocean-http-sources"],
    secrets: ["do-token"],
    tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running. A legacy state -- `params` without
// `provider` -- is whatever this value says it is; every deployment this
// package ever made ran on DigitalOcean, so a legacy `temporal-digitalocean`
// state is accepted there and refused on any other provider.
export const defaultComputeProvider = "digitalocean";

// How this package describes itself to ONCE's `compute`, the Compute Provider
// Standard's operations over a package-owned registry. The registry and the
// default are the data above; `sources` names the firewall lists the template
// reads -- SSH must list at least one CIDR, an empty HTTP list means no public
// HTTP. The name rules are ONCE's.
export const spec: compute.ComputeSpec = {
  registry: computeProviders,
  default: defaultComputeProvider,
  sources: { nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] },
};

// Every key desired state must carry whichever provider is selected. The
// provider-scoped keys come from `computeProviders`.
export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy", "temporal-version", "temporal-services",
  "temporal-namespace", "temporal-retention-days", "temporal-typescript-sdk-version",
  "node-version", "postgres-version", "postgres-data-dir", "temporal-data-dir",
  "reference-application-host", "reference-application-port",
  "reference-workflow-delay-seconds", "reference-activity-failures",
  "reference-activity-maximum-attempts", "reference-duplicate-policy",
  "cloudflare-zone", "cloudflare-proxied", "tls-provider",
];

export function missing(x: unknown): boolean {
  return x == null || (typeof x === "string" && x.trim() === "");
}

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const versionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;

// The package-local half of the DigitalOcean VPC refusal. ONCE's
// `providerErrors` refuses `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr`
// (Compute Provider Standard §5); this package has always refused the two
// other spellings a hand-edited colors.yml is likely to carry, and keeps them
// beside ONCE's.
export const forbiddenVpcKeys = ["digitalocean-vpc-id", "digitalocean-vpc-name"];

// `<provider>-<suffix>`: desired state names compute keys after the provider,
// so the shared steps reach them through the selected provider rather than a
// fixed prefix. ONCE's; named here so `tools` reads the same.
export const computeKey = compute.computeKey;

// What this deployment's machine is called: `digitalocean-name` when present,
// else the profile (Compute Name Standard). ONCE's; the Droplet, the firewall
// and `params.name` derive every label from this one answer.
export const computeName = compute.computeName;

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// A source list as desired state or an overlay string carries it. ONCE's, so
// the validator and the template can never disagree about what an entry is.
export const cidrs = compute.cidrs;

function isInteger(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x);
}

// Every problem with desired state at once: the missing keys (this package's
// and the selected provider's), the package's own checks, then the Compute
// Provider Standard's -- selection, the network contract and the provider
// rules, DigitalOcean's VPC refusal among them -- which are ONCE's over `spec`.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of [...required, ...compute.requiredKeys(spec, opts)]) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
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
  if (opts["provider-compute"] === "digitalocean" && typeof opts["digitalocean-backups"] !== "boolean") {
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
  if (opts["provider-compute"] === "digitalocean") {
    for (const key of forbiddenVpcKeys) {
      if (key in opts) {
        errors.push(`:${key} must not be configured; the default regional VPC is discovered at runtime`);
      }
    }
  }
  errors.push(...compute.stateErrors(spec, opts));
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

export function backendSecrets(opts: Opts): string[] {
  return backendEntry(opts)?.secrets ?? [];
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  if (slot === "provider-compute") return compute.tofuEnv(spec, opts);
  if (slot === "provider-dns") return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
  if (slot === "provider-backend") return backendEntry(opts)?.tofuEnv ?? {};
  return {};
}

// Credentials a real create or delete needs: the selected compute provider's,
// Cloudflare's, and the backend's.
export function secretErrors(opts: Opts): string[] {
  const keys = [...compute.secrets(spec, opts), "cloudflare-api-token", ...backendSecrets(opts)];
  return [...new Set(keys)]
    .filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}
