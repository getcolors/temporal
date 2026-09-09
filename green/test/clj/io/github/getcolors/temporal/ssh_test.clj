(ns io.github.getcolors.temporal.ssh-test
 (:require [clojure.test :refer [deftest is]]
 [io.github.getcolors.temporal.ssh :as ssh]
 [io.github.getcolors.temporal.validate-test :refer [keygen fixture]]))
(deftest build-managed-identity
 (is (= "/home/build-placeholder/.ssh/temporal-keygen-fixture" (:ssh-private-key-path (ssh/with-machine-key (keygen :green/event :build))))))
(deftest external-identity-preserved
 (is (= (fixture) (ssh/with-machine-key (fixture))))
 (is (= "/home/build-placeholder/.ssh/operator-key" (second (ssh/identity-args (fixture))))))
(deftest no-application-key-generation
 (is (= (keygen) (ssh/with-machine-key (keygen)))))
