(ns io.github.getcolors.temporal.utils
  (:require [clojure.string :as str]))

(def contract 1)

(defn disabled-provider? [v]
  (or (nil? v) (false? v) (= "no" (str/lower-case (str v)))
      (= "false" (str/lower-case (str v))) (= "null" (str/lower-case (str v)))))

(defn provider [v]
  (when-not (disabled-provider? v) (str/lower-case (str v))))

(defn host-alias [opts] (or (not-empty (str (:profile opts))) "temporal"))
