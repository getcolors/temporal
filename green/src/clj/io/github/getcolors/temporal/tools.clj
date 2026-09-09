(ns io.github.getcolors.temporal.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.temporal.compute :as compute]
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

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %)
                           (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn fallback-params [opts]
 (when (and (#{:create :delete} (:green/event opts)) (not (:green/dry-run opts))) (throw (ex-info "compute node unavailable" {})))
 (compute/node (compute/planned opts)))
(def infrastructure-step compute/infrastructure-step)

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
         :ssh-keygen (validate/keygen? opts) :ssh-identity-present (boolean (:ssh-private-key-path opts))
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
                              {:ansible_host (or (:ip opts) (:ip (fallback-params opts)))
                               :ansible_user (or (:user opts) (:user (fallback-params opts)))}}}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the converge stage. `ssh-private-key-path` reaches
  ansible.cfg so convergence uses the deployment's own key in keygen mode,
  where nothing guarantees an agent holds it. No firewall source reaches the
  play: the provider firewall is the load-bearing layer and the play manages
  no ufw (Compute Provider Standard §5)."
  [opts]
  (assoc opts
         :ip (or (:ip opts) (:ip (fallback-params opts)))
         :ssh-keygen (validate/keygen? opts) :ssh-identity-present (boolean (:ssh-private-key-path opts))
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
    (if (and (#{:create :delete} (:green/event opts)) (not (:green/dry-run opts)) (not (:ip opts)))
      (assoc opts :green/exit 1 :green/err "compute node unavailable")
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
