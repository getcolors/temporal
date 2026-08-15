(ns io.github.getcolors.temporal.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.validate :as once-validate]
            [io.github.getcolors.temporal.utils :as utils]))

(def profile-par (green-cli/par-name :profile))
(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(def required
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy :temporal-version :temporal-services
   :temporal-namespace :temporal-retention-days :temporal-typescript-sdk-version
   :node-version :postgres-version :postgres-data-dir :temporal-data-dir
   :reference-application-host :reference-application-port
   :reference-workflow-delay-seconds :reference-activity-failures
   :reference-activity-maximum-attempts :reference-duplicate-policy
   :digitalocean-name :digitalocean-region :digitalocean-size
   :digitalocean-image :digitalocean-backups
   :digitalocean-ssh-authorized-keys :digitalocean-ssh-sources
   :digitalocean-http-sources :digitalocean-https-sources
   :cloudflare-zone :cloudflare-proxied :tls-provider])

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def version-re #"^[0-9]+\.[0-9]+\.[0-9]+$")
(def forbidden-vpc-keys [:digitalocean-vpc-id :digitalocean-vpc-uuid
                         :digitalocean-vpc-cidr :digitalocean-vpc-name])

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (when-not (= "digitalocean" (:provider-compute opts))
      [":provider-compute must be digitalocean"])
    (when-not (= "cloudflare" (utils/provider (:provider-dns opts)))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (boolean? (:digitalocean-backups opts))
      [":digitalocean-backups must be true or false"])
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
    (when-not (= "ams3" (:digitalocean-region opts))
      [":digitalocean-region must be the configured Amsterdam region ams3"])
    (for [k forbidden-vpc-keys :when (contains? opts k)]
      (str k " must not be configured; the default regional VPC is discovered at runtime")))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:do-token "DIGITALOCEAN_TOKEN"}
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))

(defn secret-errors [opts]
  (let [keys (concat [:do-token :cloudflare-api-token]
                     (:secrets (get-in once-validate/providers
                                       [:provider-backend (:provider-backend opts)])))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))
