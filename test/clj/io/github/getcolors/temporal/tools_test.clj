(ns io.github.getcolors.temporal.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.ansible :as ansible]
            [io.github.getcolors.temporal.tools :as sut]
            [io.github.getcolors.temporal.validate-test :as validate-test]))

(deftest delete-cleanup-skips-when-state-has-no-compute
  ;; With the instance already gone the inventory would render 192.0.2.10;
  ;; there is no host to reach, so the step must not run the playbook and the
  ;; teardown must continue past it.
  (with-redefs [ansible/ansible-with-spec
                (fn [& _] (throw (ex-info "playbook must not run" {})))]
    (let [r (sut/ansible-step (assoc validate-test/valid :green/event :delete))]
      (is (= 0 (:green/exit r)))
      (is (= :skipped-no-compute (:temporal/cleanup r))))))

(deftest delete-cleanup-targets-the-adopted-address
  ;; When the start step recovered the instance address from state, the
  ;; cleanup playbook runs against it, never the documentation fallback.
  (with-redefs [ansible/ansible-with-spec
                (fn [opts _ _] (assoc opts :green/exit 0 ::ran-against (:ip opts)))]
    (let [r (sut/ansible-step (assoc validate-test/valid
                                     :green/event :delete :ip "203.0.113.7"))]
      (is (= "203.0.113.7" (::ran-against r))))))

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
