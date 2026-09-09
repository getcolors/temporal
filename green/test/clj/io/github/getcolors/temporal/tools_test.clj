(ns io.github.getcolors.temporal.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.ansible :as ansible]
            [green.scaffold :as sc]
            [io.github.getcolors.temporal.tools :as sut]
            [io.github.getcolors.temporal.validate-test :as validate-test :refer [fixture keygen]]))

(defn- render-play [opts]
  (sc/render-template (sut/template "ansible" "main.yml") (sut/ansible-data opts) sut/template-opts))

(deftest delete-cleanup-skips-when-state-has-no-compute
  ;; With the instance already gone the inventory would render 192.0.2.10;
  ;; there is no host to reach, so the step must not run the playbook and the
  ;; teardown must continue past it.
  (with-redefs [ansible/ansible-with-spec
                (fn [& _] (throw (ex-info "playbook must not run" {})))]
    (let [r (sut/ansible-step (assoc validate-test/valid :green/event :delete))]
      (is (= 1 (:green/exit r)))
      (is (= "compute node unavailable" (:green/err r))))))

(deftest delete-cleanup-targets-the-adopted-address
  ;; When the start step recovered the instance address from state, the
  ;; cleanup playbook runs against it, never the documentation fallback.
  (with-redefs [ansible/ansible-with-spec
                (fn [opts _ _] (assoc opts :green/exit 0 ::ran-against (:ip opts)))]
    (let [r (sut/ansible-step (assoc validate-test/valid
                                     :green/event :delete :ip "203.0.113.7" :user "ubuntu"))]
      (is (= "203.0.113.7" (::ran-against r))))))

(deftest inventory-has-private-target
  (let [s (sut/inventory {:profile "x" :ip "192.0.2.1" :user "ubuntu"})]
    (is (str/includes? s "temporal"))
    (is (str/includes? s "192.0.2.1"))))

(deftest the-provider-firewall-is-the-only-firewall
  ;; Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
  ;; no firewall source reaches it.
  (let [play (render-play (fixture))]
    (is (not (str/includes? play "ufw")))
    (is (not (str/includes? play "127.0.0.1/32"))))
  (is (not (contains? (sut/ansible-data (fixture)) :ssh-source))))
