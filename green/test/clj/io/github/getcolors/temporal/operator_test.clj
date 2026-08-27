(ns io.github.getcolors.temporal.operator-test
  (:require [clojure.test :refer [deftest is]]
            [io.github.getcolors.temporal.operator :as sut]))

(deftest acceptance-script-covers-required-behavior
  (is (re-find #"healthz" sut/acceptance-script))
  (is (re-find #"409" sut/acceptance-script))
  (is (re-find #"attempts" sut/acceptance-script))
  (is (re-find #"systemctl reboot" sut/acceptance-script))
  (is (re-find #"systemctl restart docker" sut/acceptance-script)))
