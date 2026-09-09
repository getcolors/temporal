import * as compute from "./compute.ts";
// OpenTofu and Ansible stages for the single-machine Temporal stack, the port
// of io.github.getcolors.temporal.tools.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";

import * as sshConfig from "./ssh-config.ts";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import tofuDnsTf from "../resources/tools/tofu/dns.tf" with { type: "text" };
import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };

export const infrastructureTool = "temporal-infrastructure";
export const dnsTool = "temporal-dns";
export const ansibleTool = "temporal-ansible";
export const ansibleLocalTool = "temporal-ansible-local";

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
  "tofu/dns.tf": tofuDnsTf,
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
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

// The source lists as validate parses them, so the template and the
// validator can never disagree about what an entry is. ONCE's.


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

// What `build` and `--dry-run` render in place of a compute output: the
// documentation address, shaped like the selected provider's real `params` so
// every later stage sees the same keys either way. ONCE's.
export function fallbackParams(opts:Opts){if(["create","delete"].includes(opts["red/event"])&&!opts["red/dry-run"])throw Error("compute node unavailable");return compute.node(compute.planned(opts));}
export const infrastructureStep=compute.infrastructureStep;

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

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts), "ssh-identity-present":Boolean(opts["ssh-private-key-path"]),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------- ansible

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        temporal: {
          hosts: {
            [utils.hostAlias(opts)]: {
              ansible_host: opts.ip ?? fallbackParams(opts).ip,
              ansible_user: opts.user ?? fallbackParams(opts).user,
            },
          },
        },
      },
    },
  });
}

// Template values for the converge stage. `ssh-private-key-path` reaches
// ansible.cfg so convergence uses the deployment's own key in keygen mode,
// where nothing guarantees an agent holds it. No firewall source reaches the
// play: the provider firewall is the load-bearing layer and the play manages
// no ufw (Compute Provider Standard §5).
export function ansibleData(opts: Opts): Opts {
  const services = opts["temporal-services"];
  return {
    ...opts,
    ip: opts.ip ?? fallbackParams(opts).ip,
    "ssh-keygen": validate.keygen(opts), "ssh-identity-present":Boolean(opts["ssh-private-key-path"]),
    "temporal-services-csv": (Array.isArray(services) ? services : []).join(","),
  };
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
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
  if (["create","delete"].includes(opts["red/event"]) && !opts["red/dry-run"] && !opts.ip) return {...opts,"red/exit":1,"red/err":"compute node unavailable"};
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
