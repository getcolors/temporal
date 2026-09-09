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
    (is (<= 3 (count errors)))
    (is (not-any? #(str/includes? % "ams3") errors))))

(deftest validates-secrets
  (is (= [          "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN"
              "required credential is not set: COLORS_PAR_R2_ACCESS_KEY_ID"
              "required credential is not set: COLORS_PAR_R2_SECRET_ACCESS_KEY"]
         (vec (sut/secret-errors valid)))))

(deftest refuses-profile-overlay
  (is (seq (sut/env-errors {"COLORS_PAR_PROFILE" "other"}))))

;; --- the spec handed to ONCE

(deftest region-is-required-but-not-pinned
  ;; The registry requires presence only; ams3 is a recommendation in
  ;; colors.yml, not a rule.
  (is (= [] (sut/state-errors (fixture :digitalocean-region "nyc3"))))
  (is (some #{"invalid compute deployment requirements"}
            (sut/state-errors (fixture :digitalocean-region nil)))))

(deftest legacy-alias-conflicts-are-refused
 (is (seq (sut/state-errors (fixture :digitalocean-ssh-authorized-keys "~/.ssh/id_ed25519.pub"))))
 (is (= [] (sut/state-errors (fixture :digitalocean-https-sources ["0.0.0.0/0"])))))

(deftest absent-machine-key-selects-keygen
  (is (sut/keygen? (keygen)))
  (is (not (sut/keygen? (fixture))))
  (is (sut/keygen? (fixture :digitalocean-ssh-keys nil :ssh-private-key-path nil)) "absence, not a flag, is the switch"))

(deftest backups-must-be-a-boolean
  (is (some #{"invalid compute deployment requirements"}
            (sut/state-errors (fixture :digitalocean-backups "yes")))))

(deftest keeps-the-packages-own-checks
  (is (some #(str/includes? % "in that order")
            (sut/state-errors (fixture :temporal-services ["worker" "frontend" "history" "matching"]))))
  (is (some #(str/includes? % "zone apex")
            (sut/state-errors (fixture :reference-application-host "api.example.com")))))
