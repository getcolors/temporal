(ns io.github.getcolors.temporal.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.temporal.compute :as compute]
            [io.github.getcolors.compute-ssh :as compute-ssh]
            [io.github.getcolors.once.validate :as once-validate]
            [io.github.getcolors.temporal.utils :as utils]))

(def profile-par (green-cli/par-name :profile))
(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(def default-compute-provider "digitalocean")

(def required
  "Every key desired state must carry whichever provider is selected. The
  provider-scoped keys come from `compute-providers`."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy :temporal-version :temporal-services
   :temporal-namespace :temporal-retention-days :temporal-typescript-sdk-version
   :node-version :postgres-version :postgres-data-dir :temporal-data-dir
   :reference-application-host :reference-application-port
   :reference-workflow-delay-seconds :reference-activity-failures
   :reference-activity-maximum-attempts :reference-duplicate-policy
   :cloudflare-zone :cloudflare-proxied :tls-provider])

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def version-re #"^[0-9]+\.[0-9]+\.[0-9]+$")

(defn keygen? [opts] (try (= "managed" (:mode (compute-ssh/mode opts))) (catch Exception _ true)))

(defn state-errors
  "Every problem with desired state at once: the missing keys (this package's
  and the selected provider's), the package's own checks, then the Compute
  Provider Standard's -- selection, the network contract and the provider
  rules, DigitalOcean's VPC refusal among them -- which are ONCE's over
  `spec`."
  [opts]
  (vec
   (concat
    (for [k required
          :when (missing? (get opts k))]
      (str k " is required"))
    (when-not (= "cloudflare" (utils/provider (:provider-dns opts)))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"s3" "r2"} (:provider-backend opts))
      [":provider-backend must be s3 or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (re-matches version-re (str (:temporal-version opts)))
      [":temporal-version must be an exact x.y.z version"])
    (when-not (re-matches version-re (str (:temporal-typescript-sdk-version opts)))
      [":temporal-typescript-sdk-version must be an exact x.y.z version"])
    (when-not (= ["frontend" "history" "matching" "worker"]
                 (vec (:temporal-services opts)))
      [":temporal-services must contain frontend, history, matching, and worker in that order"])
    (when-not (= "reject" (:reference-duplicate-policy opts))
      [":reference-duplicate-policy must be reject"])
    (when-not (and (integer? (:reference-activity-failures opts))
                   (integer? (:reference-activity-maximum-attempts opts))
                   (< 0 (:reference-activity-failures opts)
                      (:reference-activity-maximum-attempts opts)))
      [":reference-activity-maximum-attempts must exceed a positive :reference-activity-failures"])
    (when-not (re-matches host-re (str (:reference-application-host opts)))
      [":reference-application-host must be a fully qualified hostname"])
    (when-not (= (:reference-application-host opts) (:cloudflare-zone opts))
      [":reference-application-host must be the Cloudflare zone apex"])
    (for [key [:digitalocean-vpc-id :digitalocean-vpc-name] :when (contains? opts key)] (str "retired option " key " must be removed"))
    (compute/errors opts))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(defn secret-errors
  "Credentials a real create or delete needs: the selected compute provider's,
  Cloudflare's, and the backend's."
  [opts]
  (let [keys (concat
                     [:cloudflare-api-token]
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {}
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
