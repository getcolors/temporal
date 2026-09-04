(ns io.github.getcolors.temporal.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]
            [io.github.getcolors.temporal.utils :as utils]))

(def profile-par (green-cli/par-name :profile))
(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(def compute-providers
  "provider-compute -> what that choice implies (Compute Provider Standard §2).

  `:required` are the non-secret keys that provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, and `:tofu-env`
  the subset OpenTofu reads from the process environment itself. Keeping the
  three together is what stops a provider being validated against one set of
  keys and run with another. The keys of this map are the advertised
  providers; a provider without a template directory and a golden is not
  advertised, and this package advertises one.

  Two keys the template reads are deliberately not required.
  `digitalocean-name` is an optional override of the profile (Compute Name
  Standard), and `digitalocean-ssh-keys` is meaningful by its absence (SSH
  Keypair Standard)."
  {"digitalocean"
   {:required [:digitalocean-region :digitalocean-size :digitalocean-image
               :digitalocean-backups :digitalocean-ssh-sources
               :digitalocean-http-sources]
    :secrets [:do-token]
    :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running. A legacy state -- `params` without
  `provider` -- is whatever this value says it is; every deployment this
  package ever made ran on DigitalOcean, so a legacy `temporal-digitalocean`
  state is accepted there and refused on any other provider."
  "digitalocean")

(def spec
  "How this package describes itself to ONCE's `compute`, the Compute Provider
  Standard's operations over a package-owned registry. The registry and the
  default are the data above; `:sources` names the firewall lists the
  template reads -- SSH must list at least one CIDR, an empty HTTP list means
  no public HTTP. The name rules are ONCE's."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]}})

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

(def forbidden-vpc-keys
  "The package-local half of the DigitalOcean VPC refusal. ONCE's
  `provider-errors` refuses `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr`
  (Compute Provider Standard §5); this package has always refused the two
  other spellings a hand-edited colors.yml is likely to carry, and keeps them
  beside ONCE's."
  [:digitalocean-vpc-id :digitalocean-vpc-name])

(def compute-key
  "`:<provider>-<suffix>`: desired state names compute keys after the
  provider, so the shared steps reach them through the selected provider
  rather than a fixed prefix. ONCE's; named here so `tools` reads the same."
  compute/key)

(def compute-name
  "What this deployment's machine is called: `digitalocean-name` when present,
  else the profile (Compute Name Standard). ONCE's; the Droplet, the firewall
  and `params.name` derive every label from this one answer."
  compute/name)

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(def cidrs
  "A source list as desired state or an overlay string carries it. ONCE's, so
  the validator and the template can never disagree about what an entry is."
  compute/cidrs)

(defn state-errors
  "Every problem with desired state at once: the missing keys (this package's
  and the selected provider's), the package's own checks, then the Compute
  Provider Standard's -- selection, the network contract and the provider
  rules, DigitalOcean's VPC refusal among them -- which are ONCE's over
  `spec`."
  [opts]
  (vec
   (concat
    (for [k (concat required (compute/required-keys spec opts))
          :when (missing? (get opts k))]
      (str k " is required"))
    (when-not (= "cloudflare" (utils/provider (:provider-dns opts)))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when (and (= "digitalocean" (:provider-compute opts))
               (not (boolean? (:digitalocean-backups opts))))
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
    (when (= "digitalocean" (:provider-compute opts))
      (for [k forbidden-vpc-keys :when (contains? opts k)]
        (str k " must not be configured; the default regional VPC is discovered at runtime")))
    (compute/state-errors spec opts))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(defn secret-errors
  "Credentials a real create or delete needs: the selected compute provider's,
  Cloudflare's, and the backend's."
  [opts]
  (let [keys (concat (compute/secrets spec opts)
                     [:cloudflare-api-token]
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute (compute/tofu-env spec opts)
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
