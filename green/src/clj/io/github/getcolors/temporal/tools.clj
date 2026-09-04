(ns io.github.getcolors.temporal.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.temporal.ssh-config :as ssh-config]
            [io.github.getcolors.temporal.utils :as utils]
            [io.github.getcolors.temporal.validate :as validate]))

(def infrastructure-tool "temporal-infrastructure")
(def dns-tool "temporal-dns")
(def ansible-tool "temporal-ansible")
(def ansible-local-tool "temporal-ansible-local")
(def root "io.github.getcolors.temporal.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool]
  (green-cli/stage-dir opts tool {:default-profile "temporal"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [template target data] {:template template :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(def cidrs
  "The source lists as validate parses them, so the template and the
  validator can never disagree about what an entry is. ONCE's."
  validate/cidrs)

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %)
                           (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(def fallback-params
  "What `build` and `--dry-run` render in place of a compute output: the
  documentation address, shaped like the selected provider's real `params` so
  every later stage sees the same keys either way. ONCE's."
  compute/fallback-params)

(def resolved-compute
  "Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute
  output carries no `ip`. ONCE's; `infrastructure-step` is what wires it."
  compute/resolved-compute)

(def output-params
  "The compute stage's `params` output, keywordized and otherwise untouched.
  ONCE's."
  compute/output-params)

(def compute-key
  "`:<provider>-<suffix>`, the selected provider's key. ONCE's, via validate."
  validate/compute-key)

(def compute-name
  "The machine's name: `digitalocean-name` when present, else the profile.
  ONCE's, via validate; the Droplet, the firewall and `params.name` derive
  every label from it."
  validate/compute-name)

(defn infrastructure-data
  "Template values for the compute stage. The name, the keypair mode and the
  source lists are resolved here once, so the template interpolates values and
  never branches on which provider it belongs to. An empty
  `digitalocean-http-sources` (allowed by the standard, meaning no public
  HTTP) reaches the template as `[]`, whose dynamic 80/443 block then emits
  no rule: DigitalOcean rejects a rule with no source as an API error rather
  than a closed port."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :compute-name (compute-name opts)
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts (compute-key opts "ssh-sources")))
         :http-sources-hcl (tofu/hcl-list (cidrs opts (compute-key opts "http-sources")))))

(defn infrastructure-specs
  "Providers are selected by template directory, not by conditionals inside
  one file (Compute Provider Standard §3)."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)]
    [(spec (template (str "infrastructure." (:provider-compute opts)) "main.tf")
           (str dir "/main.tf") (infrastructure-data opts))]))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        result (tofu/tofu-with-spec opts (infrastructure-specs opts)
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (resolved-compute result (fallback-params opts) (output-params result)))))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (assoc opts :ip (or (:ip opts) (:ip (fallback-params opts))))]
    (tofu/tofu-with-spec
     opts [(spec (template "tofu" "dns.tf") (str dir "/main.tf") data)]
     {:dir dir :env (credential-env opts :provider-dns)})))

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ---------------------------------------------------------------- ansible

(defn inventory [opts]
  (json/generate-string
   {:all {:children
          {:temporal {:hosts {(utils/host-alias opts)
                              {:ansible_host (or (:ip opts) "192.0.2.10")
                               :ansible_user "root"}}}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the converge stage. `ssh-private-key-path` reaches
  ansible.cfg so convergence uses the deployment's own key in keygen mode,
  where nothing guarantees an agent holds it. No firewall source reaches the
  play: the provider firewall is the load-bearing layer and the play manages
  no ufw (Compute Provider Standard §5)."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :ssh-keygen (validate/keygen? opts)
         :temporal-services-csv (str/join "," (:temporal-services opts))))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible" "main.yml") (str dir "/main.yml") data)
     (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
     (spec (template "application" "package.json") (str dir "/application/package.json") data)
     (spec (template "application" "package-lock.json") (str dir "/application/package-lock.json") data)
     (spec (template "application" "tsconfig.json") (str dir "/application/tsconfig.json") data)
     (spec (template "application" "Dockerfile") (str dir "/application/Dockerfile") data)
     (spec (template "application/src" "activities.ts") (str dir "/application/src/activities.ts") data)
     (spec (template "application/src" "workflows.ts") (str dir "/application/src/workflows.ts") data)
     (spec (template "application/src" "index.ts") (str dir "/application/src/index.ts") data)
     (raw-spec (str dir "/inventory.json") (inventory data))]))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (not (:ip opts)))
      ;; No compute in state: there is no host to clean up, and the rendered
      ;; inventory would fall back to 192.0.2.10. Remove the rendered tree the
      ;; way a completed cleanup would and let the teardown continue.
      (assoc (sc/scaffold opts (ansible-specs opts))
             :green/exit 0 :temporal/cleanup :skipped-no-compute)
      (ansible/ansible-with-spec opts {:dir dir :inventory "inventory.json"
                                       :playbooks {:create "main.yml" :delete "cleanup.yml"}
                                       :host-key-checking false}
                                 (ansible-specs opts)))))

(defn acceptance-step [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [url (str "https://" (:reference-application-host opts) "/healthz")
          result (process/run-with-timeout ["curl" "--fail" "--silent" "--show-error"
                                            "--retry" "30" "--retry-delay" "5" url]
                                           {} 180000)]
      (if (zero? (:exit result))
        (assoc opts :green/exit 0)
        (assoc opts :green/exit 1 :green/err
               (str "public HTTPS health check failed: " (:err result)))))))
