(ns io.github.getcolors.temporal.operator
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [green.cli :as green-cli]
            [green.process :as process]
            [io.github.getcolors.temporal.validate :as validate]))

(def acceptance-script
  "set -euo pipefail
host=$1; failures=$2; restart_mode=$3
api=https://$host
body=$(mktemp); trap 'rm -f \"$body\"' EXIT
curl -fsS --retry 20 --retry-delay 3 \"$api/healthz\" | jq -e '.ok == true and .temporal == \"connected\"' >/dev/null
id=completion-$(date +%s)-$RANDOM
code=$(curl -sS -o \"$body\" -w '%{http_code}' -H 'content-type: application/json' -d \"{\\\"workflowId\\\":\\\"$id\\\",\\\"delaySeconds\\\":2}\" \"$api/workflows\")
[ \"$code\" = 202 ]
code=$(curl -sS -o \"$body\" -w '%{http_code}' -H 'content-type: application/json' -d \"{\\\"workflowId\\\":\\\"$id\\\",\\\"delaySeconds\\\":2}\" \"$api/workflows\")
[ \"$code\" = 409 ]
for _ in $(seq 1 90); do
  if curl -fsS \"$api/workflows/$id\" > \"$body\" && [ \"$(jq -r .phase \"$body\")\" = completed ]; then break; fi
  sleep 2
done
jq -e --arg id \"$id\" --argjson attempts \"$((failures + 1))\" '.temporalStatus == \"COMPLETED\" and .result.workflowId == $id and .result.value == (\"TEMPORAL:\" + $id + \":OK\") and .result.attempts == $attempts' \"$body\" >/dev/null
restart_id=restart-$(date +%s)-$RANDOM
code=$(curl -sS -o \"$body\" -w '%{http_code}' -H 'content-type: application/json' -d \"{\\\"workflowId\\\":\\\"$restart_id\\\",\\\"delaySeconds\\\":45}\" \"$api/workflows\")
[ \"$code\" = 202 ]
sleep 3
ip=$(getent ahostsv4 \"$host\" | awk 'NR==1 {print $1}')
[ -n \"$ip\" ]
ssh_opts=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
if [ \"$restart_mode\" = reboot ]; then
  ssh \"${ssh_opts[@]}\" root@\"$ip\" 'nohup sh -c \"sleep 2; systemctl reboot\" >/dev/null 2>&1 &' || true
else
  ssh \"${ssh_opts[@]}\" root@\"$ip\" 'systemctl restart docker'
fi
sleep 5
curl -fsS --retry 120 --retry-delay 5 --retry-all-errors \"$api/healthz\" >/dev/null
for _ in $(seq 1 120); do
  if curl -fsS \"$api/workflows/$restart_id\" > \"$body\" && [ \"$(jq -r .phase \"$body\")\" = completed ]; then break; fi
  sleep 2
done
jq -e --arg id \"$restart_id\" --argjson attempts \"$((failures + 1))\" '.temporalStatus == \"COMPLETED\" and .result.workflowId == $id and .result.value == (\"TEMPORAL:\" + $id + \":OK\") and .result.attempts == $attempts' \"$body\" >/dev/null
printf 'acceptance: HTTPS, completion, retry, duplicate rejection, %s persistence, status and result passed\\n' \"$restart_mode\"")

(def inherit-run process/run-inherit)

(defn run
  ([state-file args] (run state-file args inherit-run (System/getenv)))
  ([state-file args runner env]
   (try
     (let [file (io/file state-file)
           opts (-> (green-cli/read-state file (slurp file))
                    (assoc :green/state-file (.getAbsolutePath file))
                    (green-cli/read-pars env))
           errors (concat (validate/env-errors env) (validate/state-errors opts))
           mode (if (= ["--reboot"] (vec args)) "reboot" "service-restart")]
       (cond
         (seq errors) {:green/exit 2 :green/err (str/join "\n" errors)}
         (not (contains? #{[] ["--reboot"]} (vec args)))
         {:green/exit 2 :green/err "Usage: green acceptance [--reboot]"}
         :else
         (let [{:keys [exit err]}
               (runner ["bash" "-c" acceptance-script "--"
                        (str (:reference-application-host opts))
                        (str (:reference-activity-failures opts)) mode])]
           (cond-> {:green/exit (if (zero? exit) 0 (max 1 exit))}
             (and (not (zero? exit)) err) (assoc :green/err err)))))
     (catch Throwable t {:green/exit 2 :green/err (or (ex-message t) (str t))}))))
