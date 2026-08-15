(ns io.github.getcolors.temporal.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.temporal.tools :as tools]
            [io.github.getcolors.temporal.validate :as validate]))

(def defaults {:provider-compute "digitalocean" :provider-dns "cloudflare"
               :provider-backend "local" :compute-prevent-destroy true
               :workdir ".colors"})

(defn state-output [opts dir]
  (try (some-> (tofu/outputs dir (tools/backend-credential-env opts))
               :params walk/keywordize-keys)
       (catch Exception _ nil)))

(defn adopt-existing-state [opts]
  (if-let [infra (state-output opts (tools/tool-dir opts tools/infrastructure-tool))]
    (merge opts infra) opts))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          (fn [opts _ {:keys [event real?]}]
            (if (and real? (= :delete event))
              (assoc (adopt-existing-state opts) :green/exit 0)
              (assoc opts :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :temporal/start [start-step :temporal/ansible]
      :temporal/ansible [tools/ansible-step :temporal/dns]
      :temporal/dns [tools/dns-step :temporal/infrastructure]
      :temporal/infrastructure [tools/infrastructure-step])
    (case step
      :temporal/start [start-step :temporal/infrastructure]
      :temporal/infrastructure [tools/infrastructure-step :temporal/dns]
      :temporal/dns [tools/dns-step :temporal/ansible]
      :temporal/ansible [tools/ansible-step :temporal/acceptance]
      :temporal/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting [:temporal/infrastructure :temporal/dns
                     :temporal/ansible :temporal/acceptance])

(def workflow
  (-> (wf/workflow {:start :temporal/start :wire-fn wire-fn})
      (wf/advice-add :temporal/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :temporal/dns :before ::backend
                     (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
