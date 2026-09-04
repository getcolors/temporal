// The `acceptance` verb, the port of io.github.getcolors.temporal.operator:
// end-to-end verification of a converged deployment — HTTPS, workflow
// completion, retry accounting, duplicate rejection, and recovery across a
// Docker restart or a full reboot.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readPars } from "red/cli";
import { runInherit } from "red/process";
import type { Opts } from "red/workflow";
import * as ssh from "./ssh.ts";
import * as validate from "./validate.ts";

export const acceptanceScript = `set -euo pipefail
host=$1; failures=$2; restart_mode=$3; identity=\${4:-}
api=https://$host
body=$(mktemp); trap 'rm -f "$body"' EXIT
curl -fsS --retry 20 --retry-delay 3 "$api/healthz" | jq -e '.ok == true and .temporal == "connected"' >/dev/null
id=completion-$(date +%s)-$RANDOM
code=$(curl -sS -o "$body" -w '%{http_code}' -H 'content-type: application/json' -d "{\\"workflowId\\":\\"$id\\",\\"delaySeconds\\":2}" "$api/workflows")
[ "$code" = 202 ]
code=$(curl -sS -o "$body" -w '%{http_code}' -H 'content-type: application/json' -d "{\\"workflowId\\":\\"$id\\",\\"delaySeconds\\":2}" "$api/workflows")
[ "$code" = 409 ]
for _ in $(seq 1 90); do
  if curl -fsS "$api/workflows/$id" > "$body" && [ "$(jq -r .phase "$body")" = completed ]; then break; fi
  sleep 2
done
jq -e --arg id "$id" --argjson attempts "$((failures + 1))" '.temporalStatus == "COMPLETED" and .result.workflowId == $id and .result.value == ("TEMPORAL:" + $id + ":OK") and .result.attempts == $attempts' "$body" >/dev/null
restart_id=restart-$(date +%s)-$RANDOM
code=$(curl -sS -o "$body" -w '%{http_code}' -H 'content-type: application/json' -d "{\\"workflowId\\":\\"$restart_id\\",\\"delaySeconds\\":45}" "$api/workflows")
[ "$code" = 202 ]
sleep 3
ip=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}')
[ -n "$ip" ]
ssh_opts=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
if [ -n "$identity" ]; then ssh_opts+=(-o IdentitiesOnly=yes -i "$identity"); fi
if [ "$restart_mode" = reboot ]; then
  ssh "\${ssh_opts[@]}" root@"$ip" 'nohup sh -c "sleep 2; systemctl reboot" >/dev/null 2>&1 &' || true
else
  ssh "\${ssh_opts[@]}" root@"$ip" 'systemctl restart docker'
fi
sleep 5
curl -fsS --retry 120 --retry-delay 5 --retry-all-errors "$api/healthz" >/dev/null
for _ in $(seq 1 120); do
  if curl -fsS "$api/workflows/$restart_id" > "$body" && [ "$(jq -r .phase "$body")" = completed ]; then break; fi
  sleep 2
done
jq -e --arg id "$restart_id" --argjson attempts "$((failures + 1))" '.temporalStatus == "COMPLETED" and .result.workflowId == $id and .result.value == ("TEMPORAL:" + $id + ":OK") and .result.attempts == $attempts' "$body" >/dev/null
printf 'acceptance: HTTPS, completion, retry, duplicate rejection, %s persistence, status and result passed\\n' "$restart_mode"`;

export const inheritRun = runInherit;

export async function run(
  stateFile: string,
  args: string[],
  runner: typeof runInherit = inheritRun,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  try {
    const opts = readPars({
      ...((Bun.YAML.parse(readFileSync(stateFile, "utf8")) ?? {}) as Opts),
      "red/state-file": resolve(stateFile),
    }, env);
    const errors = [...validate.envErrors(env), ...validate.stateErrors(opts)];
    const argv = [...args];
    const mode = argv.length === 1 && argv[0] === "--reboot" ? "reboot" : "service-restart";
    if (errors.length) return { "red/exit": 2, "red/err": errors.join("\n") };
    if (!(argv.length === 0 || (argv.length === 1 && argv[0] === "--reboot"))) {
      return { "red/exit": 2, "red/err": "Usage: red acceptance [--reboot]" };
    }
    const { exit, err } = await runner(["bash", "-c", acceptanceScript, "--",
      String(opts["reference-application-host"]),
      String(opts["reference-activity-failures"]), mode,
      // In keygen mode the deployment's own key is the machine's only access
      // key (SSH Keypair Standard §7); nothing guarantees an agent holds it.
      validate.keygen(opts) ? ssh.privateKeyPath(opts) : ""]);
    return {
      "red/exit": exit === 0 ? 0 : Math.max(1, exit),
      ...(exit !== 0 && err ? { "red/err": err } : {}),
    };
  } catch (t) {
    return {
      "red/exit": 2,
      "red/err": t instanceof Error ? t.message || t.constructor.name : String(t),
    };
  }
}
