(ns io.github.getcolors.temporal.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.tools :as sut]))

(deftest inventory-has-private-target
  (let [s (sut/inventory {:profile "x" :ip "192.0.2.1"})]
    (is (str/includes? s "temporal"))
    (is (str/includes? s "192.0.2.1"))))

(deftest infrastructure-renders-three-ingress-groups
  (let [data (sut/infrastructure-data
              {:green/event :build :digitalocean-ssh-authorized-keys "x"
               :digitalocean-ssh-sources ["1.2.3.4/32"]
               :digitalocean-http-sources ["0.0.0.0/0"]
               :digitalocean-https-sources ["0.0.0.0/0"]})]
    (is (str/includes? (:ssh-sources-hcl data) "1.2.3.4/32"))
    (is (str/includes? (:http-sources-hcl data) "0.0.0.0/0"))))
