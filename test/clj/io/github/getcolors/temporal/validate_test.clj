(ns io.github.getcolors.temporal.validate-test
  (:require [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.validate :as sut]))

(def valid {:profile "x" :workdir ".colors" :provider-compute "digitalocean"
 :provider-dns "cloudflare" :provider-backend "local" :compute-prevent-destroy true
 :temporal-version "1.31.2" :temporal-services ["frontend" "history" "matching" "worker"]
 :temporal-namespace "benchmark" :temporal-retention-days 7
 :temporal-typescript-sdk-version "1.22.0" :node-version 22 :postgres-version 17
 :postgres-data-dir "/data/postgresql" :temporal-data-dir "/data/temporal"
 :reference-application-host "example.com" :reference-application-port 3000
 :reference-workflow-delay-seconds 120 :reference-activity-failures 2
 :reference-activity-maximum-attempts 5 :reference-duplicate-policy "reject"
 :digitalocean-name "x" :digitalocean-region "ams3" :digitalocean-size "c-8"
 :digitalocean-image "ubuntu" :digitalocean-backups true
 :digitalocean-ssh-authorized-keys "~/.ssh/id.pub"
 :digitalocean-ssh-sources ["1.2.3.4/32"]
 :digitalocean-http-sources ["0.0.0.0/0"] :digitalocean-https-sources ["0.0.0.0/0"]
 :cloudflare-zone "example.com" :cloudflare-proxied false :tls-provider "letsencrypt"})

(deftest validates-complete-state (is (empty? (sut/state-errors valid))))
(deftest reports-all-errors
  (let [errors (sut/state-errors (-> valid (dissoc :profile)
                                      (assoc :provider-dns "bad"
                                             :digitalocean-region "nyc3"
                                             :digitalocean-vpc-id "invented")))]
    (is (<= 4 (count errors)))))
(deftest validates-secrets
  (is (= ["required credential is not set: COLORS_PAR_DO_TOKEN"
          "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN"]
         (vec (sut/secret-errors valid)))))
(deftest refuses-profile-overlay
  (is (seq (sut/env-errors {"COLORS_PAR_PROFILE" "other"}))))
