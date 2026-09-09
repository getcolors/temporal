(ns io.github.getcolors.temporal.operator-test
  (:require [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.operator :as sut]))

(deftest acceptance-script-covers-required-behavior
  (is (re-find #"healthz" sut/acceptance-script))
  (is (re-find #"409" sut/acceptance-script))
  (is (re-find #"attempts" sut/acceptance-script))
  (is (re-find #"systemctl reboot" sut/acceptance-script))
  (is (re-find #"systemctl restart docker" sut/acceptance-script))
  ;; Keygen mode: the deployment's own key is the machine's only access key.
  (is (re-find #"IdentitiesOnly=yes -i" sut/acceptance-script)))

(deftest acceptance-uses-owned-state-before-execution
 (let [calls (atom [])
       loader (fn [opts _] (swap! calls conj :state) (assoc opts :green/exit 0 :ip "203.0.113.7" :user "ubuntu" :ssh-private-key-path "/tmp/operator-key"))
       runner (fn [argv] (swap! calls conj argv) {:exit 0 :out "" :err ""})
       result (sut/run "test/fixtures/colors.yml" [] runner {} loader)]
  (is (= 0 (:green/exit result))) (is (= :state (first @calls)))
  (is (= ["/tmp/operator-key" "203.0.113.7" "ubuntu"] (vec (take-last 3 (second @calls)))))
  (is (not (re-find #"getent" sut/acceptance-script)))
  (is (re-find #"sudo -n -- sh -c" sut/acceptance-script))))

(deftest unreadable-state-refuses-acceptance
 (let [result (sut/run "test/fixtures/colors.yml" [] (fn [_] (throw (ex-info "must not execute" {}))) {} (fn [_ _] {:green/exit 1 :green/err "state unreadable"}))]
  (is (= 1 (:green/exit result))) (is (= "state unreadable" (:green/err result)))))
