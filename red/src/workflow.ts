// Lifecycle graph and backend advice, the port of
// io.github.getcolors.temporal.workflow.

import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "digitalocean", "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// Compute params recorded in the infrastructure state; undefined when the
// state holds none. An unreadable backend throws — the delete path treats
// that as fatal rather than falling back to the documentation address.
export async function stateOutput(opts: Opts, dir: string): Promise<Opts | undefined> {
  const outputs = await tofu.outputs(dir, tools.backendCredentialEnv(opts));
  const params = outputs.params;
  return params && typeof params === "object" ? params as Opts : undefined;
}

// A real delete runs the ansible cleanup before the infrastructure step, so
// the instance address must come out of the existing state here. An explicit
// `ip` (COLORS_PAR_IP) skips the read; a readable state without compute params
// leaves `ip` unset and the cleanup step skips itself; an unreadable backend
// fails loudly — swallowing it is how a live teardown ended up converging
// against 192.0.2.10.
export async function adoptState(
  opts: Opts,
  readState: typeof stateOutput = stateOutput,
): Promise<Opts> {
  if (opts.ip) return { ...opts, "red/exit": 0 };
  try {
    const params = await readState(opts, tools.toolDir(opts, tools.infrastructureTool));
    return { ...opts, ...(params ?? {}), "red/exit": 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...opts, "red/exit": 1,
      "red/err": "could not read the infrastructure state for " +
        `the delete cleanup: ${message}\n` +
        "fix the backend credentials, or supply " +
        `${parName("ip")} to address the instance directly`,
    };
  }
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  readState: typeof stateOutput = stateOutput,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && (event === "create" || event === "delete")
          ? validate.secretErrors(current)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    afterValidate: (current, _environment, { event, real }) =>
      real && event === "delete"
        ? adoptState(current, readState)
        : { ...current, "red/exit": 0 },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "temporal/start": [startStep, "temporal/ansible"],
      "temporal/ansible": [tools.ansibleStep, "temporal/dns"],
      "temporal/dns": [tools.dnsStep, "temporal/infrastructure"],
      "temporal/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "temporal/start": [startStep, "temporal/infrastructure"],
    "temporal/infrastructure": [tools.infrastructureStep, "temporal/dns"],
    "temporal/dns": [tools.dnsStep, "temporal/ansible"],
    "temporal/ansible": [tools.ansibleStep, "temporal/acceptance"],
    "temporal/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "temporal/infrastructure", "temporal/dns",
  "temporal/ansible", "temporal/acceptance",
];

function create() {
  let wf = workflow({ start: "temporal/start", wireFn });
  wf = adviceAdd(wf, "temporal/infrastructure", "before",
    "io.github.getcolors.temporal.workflow/backend",
    backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "temporal/dns", "before",
    "io.github.getcolors.temporal.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const temporalWorkflow = create();
