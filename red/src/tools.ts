// OpenTofu and Ansible stages for the single-machine Temporal stack, the port
// of io.github.getcolors.temporal.tools.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };
import tofuDnsTf from "../resources/tools/tofu/dns.tf" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };

export const infrastructureTool = "temporal-infrastructure";
export const dnsTool = "temporal-dns";
export const ansibleTool = "temporal-ansible";

export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "temporal" });
}

// The reference-application templates are read at runtime rather than
// text-imported: a static import of a `.ts` template would put the reference
// application itself — whose @temporalio dependencies are deliberately not
// installed here — on tsc's program, and fail the typecheck of this package.
// The published package ships red/resources, so the same relative read works
// from a checkout and from the resolved pin.
function applicationTemplate(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "resources", "tools", name), "utf8");
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string | (() => string)> = {
  "infrastructure/main.tf": infrastructureMainTf,
  "tofu/dns.tf": tofuDnsTf,
  "ansible/ansible.cfg": ansibleCfg,
  "ansible/main.yml": ansibleMain,
  "ansible/cleanup.yml": ansibleCleanup,
  "application/package.json": () => applicationTemplate("application/package.json"),
  "application/package-lock.json": () => applicationTemplate("application/package-lock.json"),
  "application/tsconfig.json": () => applicationTemplate("application/tsconfig.json"),
  "application/Dockerfile": () => applicationTemplate("application/Dockerfile"),
  "application/src/activities.ts": () => applicationTemplate("application/src/activities.ts"),
  "application/src/workflows.ts": () => applicationTemplate("application/src/workflows.ts"),
  "application/src/index.ts": () => applicationTemplate("application/src/index.ts"),
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new StepError(`template not found: ${name}`);
  return { name, content: typeof content === "function" ? content() : content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function cidrs(opts: Opts, k: string): string[] {
  const v = opts[k];
  const xs = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
  return xs.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  ) as Record<string, string>;
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

const zeroFingerprint = "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00";

export async function sshFingerprint(path: unknown): Promise<string> {
  const resolved = String(path).replaceAll("~/", `${homedir()}/`);
  const result = await runtime.exec(["ssh-keygen", "-E", "md5", "-lf", resolved]);
  if (result.exit !== 0) return zeroFingerprint;
  const match = result.out.match(/(MD5:[0-9a-f:]+)/);
  return match ? match[1]!.replace("MD5:", "") : zeroFingerprint;
}

export function fallbackParams(opts: Opts): Opts {
  return { ip: "192.0.2.10", user: "root", sudoer: "root", name: opts.profile };
}

export async function infrastructureData(opts: Opts): Promise<Opts> {
  return {
    ...opts,
    "digitalocean-ssh-key-fingerprint": opts["red/event"] === "build"
      ? zeroFingerprint
      : await sshFingerprint(opts["digitalocean-ssh-authorized-keys"]),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-ssh-sources")),
    "http-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-http-sources")),
    "https-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-https-sources")),
  };
}

export function outputParams(result: Opts): Opts | undefined {
  const outputs = result["tofu/outputs"] as Record<string, unknown> | undefined;
  const params = outputs?.params;
  return params && typeof params === "object" ? params as Opts : undefined;
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const data = await infrastructureData(opts);
  const specs = [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`, data)];
  const result = await tofu.tofuWithSpec(opts, specs, {
    dir, env: credentialEnv(opts, "provider-compute"),
  });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return { ...result, ...fallbackParams(opts), ...(outputParams(result) ?? {}) };
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const data = { ...opts, ip: opts.ip ?? fallbackParams(opts).ip };
  return tofu.tofuWithSpec(
    opts, [spec(template("tofu", "dns.tf"), `${dir}/main.tf`, data)],
    { dir, env: credentialEnv(opts, "provider-dns") },
  );
}

// Cheshire's pretty printer, byte for byte: spaces around colons, arrays
// inline, nested objects newline-indented, floats in Java's Double.toString
// notation (JS's shortest-round-trip digits are the same digits Java chooses;
// only the layout differs).
function javaNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const negative = value < 0;
  const [mantissa, exponentPart] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa!.replace(".", "");
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const intPart = digits.padEnd(exponent + 1, "0").slice(0, exponent + 1);
      const fracPart = digits.slice(exponent + 1);
      body = `${intPart}.${fracPart.length > 0 ? fracPart : "0"}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}.${rest.length > 0 ? rest : "0"}E${exponent}`;
  }
  return negative ? `-${body}` : body;
}

function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        temporal: {
          hosts: {
            [utils.hostAlias(opts)]: {
              ansible_host: opts.ip ?? "192.0.2.10",
              ansible_user: "root",
            },
          },
        },
      },
    },
  });
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const services = opts["temporal-services"];
  const data = {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "ssh-source": cidrs(opts, "digitalocean-ssh-sources")[0],
    "temporal-services-csv": (Array.isArray(services) ? services : []).join(","),
  };
  return [
    spec(template("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible", "main.yml"), `${dir}/main.yml`, data),
    spec(template("ansible", "cleanup.yml"), `${dir}/cleanup.yml`, data),
    spec(template("application", "package.json"), `${dir}/application/package.json`, data),
    spec(template("application", "package-lock.json"), `${dir}/application/package-lock.json`, data),
    spec(template("application", "tsconfig.json"), `${dir}/application/tsconfig.json`, data),
    spec(template("application", "Dockerfile"), `${dir}/application/Dockerfile`, data),
    spec(template("application/src", "activities.ts"), `${dir}/application/src/activities.ts`, data),
    spec(template("application/src", "workflows.ts"), `${dir}/application/src/workflows.ts`, data),
    spec(template("application/src", "index.ts"), `${dir}/application/src/index.ts`, data),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to clean up, and the rendered
    // inventory would fall back to 192.0.2.10. Remove the rendered tree the
    // way a completed cleanup would and let the teardown continue.
    return {
      ...scaffold(opts, ansibleSpecs(opts)),
      "red/exit": 0, "temporal/cleanup": "skipped-no-compute",
    };
  }
  return ansible.ansibleWithSpec(opts, {
    dir, inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const url = `https://${opts["reference-application-host"]}/healthz`;
  const result = await runtime.exec(
    ["curl", "--fail", "--silent", "--show-error", "--retry", "30", "--retry-delay", "5", url],
    { timeoutMs: 180000 },
  );
  if (result.exit === 0) return { ...opts, "red/exit": 0 };
  return {
    ...opts, "red/exit": 1,
    "red/err": `public HTTPS health check failed: ${result.err}`,
  };
}
