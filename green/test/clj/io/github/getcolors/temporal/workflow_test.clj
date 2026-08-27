(ns io.github.getcolors.temporal.workflow-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.validate-test :as validate-test]
            [io.github.getcolors.temporal.workflow :as sut]))

(defn deletable-opts
  "Opts that pass real-delete preflight: guard lifted, secrets present."
  [& {:as overrides}]
  (merge validate-test/valid
         {:compute-prevent-destroy false :do-token "t" :cloudflare-api-token "t"
          :green/event :delete}
         overrides))

(deftest delete-fails-loudly-when-state-is-unreadable
  ;; Swallowing a failed state read is how a live teardown ended up pointing
  ;; the cleanup playbook at 192.0.2.10: stale backend credentials made
  ;; `tofu output` fail, nil was merged, and the inventory fell back to
  ;; TEST-NET. The failure must surface here, before any playbook runs.
  (with-redefs [sut/state-output (fn [_ _] (throw (ex-info "Unauthorized" {})))]
    (let [r (sut/start-step (deletable-opts) {})]
      (is (= 1 (:green/exit r)))
      (is (str/includes? (:green/err r) "Unauthorized"))
      (is (str/includes? (:green/err r) "COLORS_PAR_IP")))))

(deftest delete-with-explicit-ip-skips-the-state-read
  ;; COLORS_PAR_IP is the operator's escape hatch when the state backend is
  ;; unreachable; it must not require the read it exists to replace.
  (with-redefs [sut/state-output (fn [_ _] (throw (ex-info "must not be called" {})))]
    (let [r (sut/start-step (deletable-opts :ip "203.0.113.7") {})]
      (is (= 0 (:green/exit r)))
      (is (= "203.0.113.7" (:ip r))))))

(deftest delete-with-empty-state-proceeds-without-an-address
  ;; State readable, no compute recorded: the instance is already gone, the
  ;; cleanup step skips itself, and the rest of the teardown still runs.
  (with-redefs [sut/state-output (fn [_ _] nil)]
    (let [r (sut/start-step (deletable-opts) {})]
      (is (= 0 (:green/exit r)))
      (is (nil? (:ip r))))))

(deftest graph-order
  (is (= :temporal/infrastructure (second (sut/wire-fn :temporal/start {:green/event :create}))))
  (is (= :temporal/ansible (second (sut/wire-fn :temporal/start {:green/event :delete}))))
  (is (= :temporal/acceptance (second (sut/wire-fn :temporal/ansible {:green/event :create})))))

(deftest profile-overlay-refused
  (let [r (sut/start-step {:green/event :build} {"COLORS_PAR_PROFILE" "other"})]
    (is (= 2 (:green/exit r)))))
