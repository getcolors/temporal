(ns io.github.getcolors.temporal.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.temporal.utils :as utils]
            [io.github.getcolors.temporal.validate :as validate]))

(def infrastructure-tool "temporal-infrastructure")
(def dns-tool "temporal-dns")
(def ansible-tool "temporal-ansible")
(def root "io.github.getcolors.temporal.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool]
  (green-cli/stage-dir opts tool {:default-profile "temporal"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [template target data] {:template template :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn cidrs [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %)
                           (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn ssh-fingerprint [path]
  (let [path (str/replace (str path) "~/" (str (System/getProperty "user.home") "/"))
        result (process/run ["ssh-keygen" "-E" "md5" "-lf" path])]
    (if (zero? (:exit result))
      (or (some-> (second (re-find #"(MD5:[0-9a-f:]+)" (:out result)))
                  (str/replace "MD5:" ""))
          "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00")
      "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00")))

(defn fallback-params [opts]
  {:ip "192.0.2.10" :user "root" :sudoer "root" :name (:profile opts)})

(defn infrastructure-data [opts]
  (assoc opts
         :digitalocean-ssh-key-fingerprint
         (if (= :build (:green/event opts))
           "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"
           (ssh-fingerprint (:digitalocean-ssh-authorized-keys opts)))
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts :digitalocean-ssh-sources))
         :http-sources-hcl (tofu/hcl-list (cidrs opts :digitalocean-http-sources))
         :https-sources-hcl (tofu/hcl-list (cidrs opts :digitalocean-https-sources))))

(defn output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool) data (infrastructure-data opts)
        specs [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)]
        result (tofu/tofu-with-spec opts specs
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (merge result (fallback-params opts) (output-params result)))))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (assoc opts :ip (or (:ip opts) (:ip (fallback-params opts))))]
    (tofu/tofu-with-spec
     opts [(spec (template "tofu" "dns.tf") (str dir "/main.tf") data)]
     {:dir dir :env (credential-env opts :provider-dns)})))

(defn inventory [opts]
  (json/generate-string
   {:all {:children
          {:temporal {:hosts {(utils/host-alias opts)
                              {:ansible_host (or (:ip opts) "192.0.2.10")
                               :ansible_user "root"}}}}}}
   {:pretty true}))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool)
        data (assoc opts
                    :ip (or (:ip opts) "192.0.2.10")
                    :ssh-source (first (cidrs opts :digitalocean-ssh-sources))
                    :temporal-services-csv (str/join "," (:temporal-services opts)))]
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
