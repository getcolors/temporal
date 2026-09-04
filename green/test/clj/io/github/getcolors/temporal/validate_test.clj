(ns io.github.getcolors.temporal.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.temporal.validate :as sut]))

(def fixture-file "test/fixtures/colors.yml")
(def keygen-file "test/fixtures/keygen.yml")
(defn read-fixture [file overrides]
  (merge (green-cli/read-state file (str/replace (slurp file) "WORKDIR" ".colors"))
         overrides))
(defn fixture
  "DigitalOcean, opt-out mode: an explicit key id and a name equal to the profile."
  [& {:as overrides}] (read-fixture fixture-file overrides))
(defn keygen
  "DigitalOcean, keygen mode: no `digitalocean-ssh-keys`, no `digitalocean-name`."
  [& {:as overrides}] (read-fixture keygen-file overrides))

;; The historical inline valid map, kept so the older tests read as they did.
(def valid (fixture :profile "x" :digitalocean-name "x" :digitalocean-image "ubuntu"
                    :digitalocean-ssh-sources ["1.2.3.4/32"]
                    :digitalocean-http-sources ["0.0.0.0/0"]))

(deftest validates-complete-state
  (is (empty? (sut/state-errors valid)))
  (is (= [] (sut/state-errors (fixture))))
  (is (= [] (sut/state-errors (keygen)))))

(deftest reports-all-errors
  ;; The `:digitalocean-region "nyc3"` override no longer counts: the hardcoded
  ;; ams3 check went with the Compute Provider Standard (the registry requires
  ;; presence only), so an empty SSH list takes its place in the tally.
  (let [errors (sut/state-errors (-> valid (dissoc :profile)
                                      (assoc :provider-dns "bad"
                                             :digitalocean-region "nyc3"
                                             :digitalocean-ssh-sources []
                                             :digitalocean-vpc-id "invented")))]
    (is (<= 4 (count errors)))
    (is (not-any? #(str/includes? % "ams3") errors))))

(deftest validates-secrets
  (is (= ["required credential is not set: COLORS_PAR_DO_TOKEN"
          "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN"]
         (vec (sut/secret-errors valid)))))

(deftest refuses-profile-overlay
  (is (seq (sut/env-errors {"COLORS_PAR_PROFILE" "other"}))))

;; --- the spec handed to ONCE

(deftest the-spec-carries-this-packages-registry-sources-and-default
  ;; The operations are ONCE's; this is the data they run over. A colour
  ;; whose registry, sources or default drifts fails here, in that colour.
  (is (= #{"digitalocean"} (set (keys (:registry sut/spec)))))
  (is (= sut/compute-providers (:registry sut/spec)))
  (is (= {:required [:digitalocean-region :digitalocean-size :digitalocean-image
                     :digitalocean-backups :digitalocean-ssh-sources
                     :digitalocean-http-sources]
          :secrets [:do-token]
          :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}
         (get-in sut/spec [:registry "digitalocean"])))
  (is (= {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]} (:sources sut/spec)))
  ;; DigitalOcean: the default is what a legacy state without params.provider
  ;; is, and every deployment this package made ran there.
  (is (= "digitalocean" (:default sut/spec)))
  (is (= sut/default-compute-provider (:default sut/spec)))
  (is (not (contains? sut/spec :name-rules)) "the name rules are ONCE's"))

;; --- the compute-provider registry

(deftest compute-provider-must-be-one-the-package-has-a-template-for
  (let [errors (sut/state-errors (fixture :provider-compute "vultr"))]
    (is (some #{":provider-compute must be one of digitalocean"} errors))))

(deftest region-is-required-but-not-pinned
  ;; The registry requires presence only; ams3 is a recommendation in
  ;; colors.yml, not a rule.
  (is (= [] (sut/state-errors (fixture :digitalocean-region "nyc3"))))
  (is (some #{":digitalocean-region is required"}
            (sut/state-errors (fixture :digitalocean-region nil)))))

(deftest name-and-machine-key-are-never-required
  ;; `digitalocean-name` is an optional override of the profile and
  ;; `digitalocean-ssh-keys` is meaningful by its absence, so neither may be
  ;; in the registry's required list -- a required machine key would make
  ;; keygen mode unreachable.
  (doseq [k (get-in sut/compute-providers ["digitalocean" :required])]
    (is (not (str/ends-with? (name k) "-name")) (str k))
    (is (not (str/ends-with? (name k) "-ssh-keys")) (str k)))
  (is (= [] (sut/state-errors (fixture :digitalocean-name nil :digitalocean-ssh-keys nil)))))

(deftest retired-keys-are-accepted-and-ignored
  ;; `digitalocean-ssh-authorized-keys` (the pre-standard fingerprint path) and
  ;; `digitalocean-https-sources` (443 now follows http-sources) are neither
  ;; required nor read; a colors.yml that still carries them validates.
  (is (= [] (sut/state-errors (fixture :digitalocean-ssh-authorized-keys "~/.ssh/id_ed25519.pub"
                                       :digitalocean-https-sources ["0.0.0.0/0"]))))
  (is (= [] (sut/state-errors (fixture :digitalocean-ssh-authorized-keys "x"
                                       :digitalocean-ssh-keys nil))))
  ;; And absence of the retired key is not what selects keygen.
  (is (not (sut/keygen? (fixture :digitalocean-ssh-authorized-keys nil)))))

(deftest absent-machine-key-selects-keygen
  (is (sut/keygen? (keygen)))
  (is (not (sut/keygen? (fixture))))
  (is (sut/keygen? (fixture :digitalocean-ssh-keys nil)) "absence, not a flag, is the switch"))

(deftest compute-name-falls-back-to-the-profile
  (is (= "temporal-fixture" (sut/compute-name (fixture))))
  (is (= "temporal-keygen-fixture" (sut/compute-name (keygen))))
  (is (= "custom" (sut/compute-name (fixture :digitalocean-name "custom"))))
  (is (= :digitalocean-ssh-sources (sut/compute-key (fixture) "ssh-sources"))))

(deftest compute-credentials-follow-the-provider
  (is (= {:do-token "DIGITALOCEAN_TOKEN"} (sut/tofu-env (fixture) :provider-compute)))
  (is (= {} (sut/tofu-env (fixture :provider-compute "vultr") :provider-compute))))

;; --- the network contract, wired through state-errors with ONCE's messages

(deftest ssh-sources-must-not-be-empty
  ;; A machine nobody can reach is not a deployment; an empty HTTP list is
  ;; simply no public HTTP.
  (is (some #{":digitalocean-ssh-sources must list at least one CIDR"}
            (sut/state-errors (fixture :digitalocean-ssh-sources []))))
  (is (= [] (sut/state-errors (fixture :digitalocean-http-sources [])))))

(deftest malformed-sources-are-refused-before-any-provider-call
  (is (some #{":digitalocean-ssh-sources entry \"nope\" is not an IPv4 or IPv6 CIDR"}
            (sut/state-errors (fixture :digitalocean-ssh-sources ["0.0.0.0/0" "nope"]))))
  (is (some #{":digitalocean-http-sources entry \"203.0.113.0\" is not an IPv4 or IPv6 CIDR"}
            (sut/state-errors (fixture :digitalocean-http-sources ["203.0.113.0"]))))
  (is (= [] (sut/state-errors (fixture :digitalocean-ssh-sources ["2001:db8::/32" "203.0.113.4/32"])))))

;; --- provider checks

(deftest forbids-vpc-configuration
  (testing "ONCE's two"
    (is (some #(str/includes? % "vpc-uuid")
              (sut/state-errors (fixture :digitalocean-vpc-uuid "forbidden"))))
    (is (some #(str/includes? % "must be absent")
              (sut/state-errors (fixture :digitalocean-vpc-cidr "10.0.0.0/16")))))
  (testing "and this package's two"
    (is (some #{":digitalocean-vpc-id must not be configured; the default regional VPC is discovered at runtime"}
              (sut/state-errors (fixture :digitalocean-vpc-id "invented"))))
    (is (some #(str/includes? % "vpc-name")
              (sut/state-errors (fixture :digitalocean-vpc-name "invented"))))))

(deftest backups-must-be-a-boolean
  (is (some #{":digitalocean-backups must be true or false"}
            (sut/state-errors (fixture :digitalocean-backups "yes")))))

(deftest keeps-the-packages-own-checks
  (is (some #(str/includes? % "in that order")
            (sut/state-errors (fixture :temporal-services ["worker" "frontend" "history" "matching"]))))
  (is (some #(str/includes? % "zone apex")
            (sut/state-errors (fixture :reference-application-host "api.example.com")))))
