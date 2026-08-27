"""The `acceptance` verb, the port of io.github.getcolors.temporal.operator:
end-to-end verification of a converged deployment — HTTPS, workflow completion,
retry accounting, duplicate rejection, and recovery across a Docker restart or
a full reboot."""

from __future__ import annotations

import os
from pathlib import Path

from blue.cli import load_yaml, read_pars
from blue.process import run_inherit

from . import validate

ACCEPTANCE_SCRIPT = """set -euo pipefail
host=$1; failures=$2; restart_mode=$3
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
if [ "$restart_mode" = reboot ]; then
  ssh "${ssh_opts[@]}" root@"$ip" 'nohup sh -c "sleep 2; systemctl reboot" >/dev/null 2>&1 &' || true
else
  ssh "${ssh_opts[@]}" root@"$ip" 'systemctl restart docker'
fi
sleep 5
curl -fsS --retry 120 --retry-delay 5 --retry-all-errors "$api/healthz" >/dev/null
for _ in $(seq 1 120); do
  if curl -fsS "$api/workflows/$restart_id" > "$body" && [ "$(jq -r .phase "$body")" = completed ]; then break; fi
  sleep 2
done
jq -e --arg id "$restart_id" --argjson attempts "$((failures + 1))" '.temporalStatus == "COMPLETED" and .result.workflowId == $id and .result.value == ("TEMPORAL:" + $id + ":OK") and .result.attempts == $attempts' "$body" >/dev/null
printf 'acceptance: HTTPS, completion, retry, duplicate rejection, %s persistence, status and result passed\\n' "$restart_mode\""""

inherit_run = run_inherit


def run(state_file: str, args: list[str], runner=None, env: dict | None = None) -> dict:
    runner = runner or inherit_run
    environment = dict(os.environ) if env is None else env
    try:
        file = Path(state_file)
        opts = read_pars({**load_yaml(file.read_text()),
                          "blue/state-file": str(file.absolute())}, environment)
        errors = [*validate.env_errors(environment), *validate.state_errors(opts)]
        mode = "reboot" if list(args) == ["--reboot"] else "service-restart"
        if errors:
            return {"blue/exit": 2, "blue/err": "\n".join(errors)}
        if list(args) not in ([], ["--reboot"]):
            return {"blue/exit": 2, "blue/err": "Usage: blue acceptance [--reboot]"}
        result = runner(["bash", "-c", ACCEPTANCE_SCRIPT, "--",
                         str(opts.get("reference-application-host")),
                         str(opts.get("reference-activity-failures")), mode])
        outcome = {"blue/exit": 0 if result.exit == 0 else max(1, result.exit)}
        if result.exit != 0 and result.err:
            outcome["blue/err"] = result.err
        return outcome
    except BaseException as t:  # noqa: BLE001 — mirror green's Throwable catch
        return {"blue/exit": 2, "blue/err": str(t) or type(t).__name__}
