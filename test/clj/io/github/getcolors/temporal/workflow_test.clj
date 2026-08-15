(ns io.github.getcolors.temporal.workflow-test
  (:require [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.workflow :as sut]))

(deftest graph-order
  (is (= :temporal/infrastructure (second (sut/wire-fn :temporal/start {:green/event :create}))))
  (is (= :temporal/ansible (second (sut/wire-fn :temporal/start {:green/event :delete}))))
  (is (= :temporal/acceptance (second (sut/wire-fn :temporal/ansible {:green/event :create})))))

(deftest profile-overlay-refused
  (let [r (sut/start-step {:green/event :build} {"COLORS_PAR_PROFILE" "other"})]
    (is (= 2 (:green/exit r)))))
