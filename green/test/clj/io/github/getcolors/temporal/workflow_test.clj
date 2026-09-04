(ns io.github.getcolors.temporal.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.temporal.validate-test :as validate-test :refer [fixture keygen]]
            [io.github.getcolors.temporal.workflow :as sut]))

;; The compute state is read once per run, through `state-output`, on a real
;; create or delete. Every lifecycle test stubs it: nil is a readable state
;; holding no compute, a map is a recorded `params`, and a throw is a backend
;; that cannot be read.
(defn- start [opts state]
  (with-redefs [sut/state-output (fn [_] state)]
    (sut/start-step opts {})))

(defn- start-unreadable
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  ([opts] (start-unreadable opts "tofu output failed: no backend"))
  ([opts message]
   (with-redefs [sut/state-output (fn [_] (throw (ex-info message {:dir "x"})))]
     (sut/start-step opts {}))))

(def credentials {:do-token "d" :cloudflare-api-token "c"})

(defn deletable-opts
  "Opts that pass real-delete preflight: guard lifted, secrets present."
  [& {:as overrides}]
  (merge validate-test/valid
         {:compute-prevent-destroy false :do-token "t" :cloudflare-api-token "t"
          :green/event :delete}
         overrides))

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (sut/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (sut/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))

(deftest build-and-dry-run-never-touch-ssh-or-state
  ;; The standard forbids reading, creating, or requiring anything under ~/.ssh
  ;; on a build or dry-run: they render from desired state alone. Nor do they
  ;; read the backend: a throwing state read proves nothing on these paths
  ;; reaches it.
  (doseq [opts [(assoc (keygen) :green/event :build)
                (assoc (keygen) :green/event :create :green/dry-run true)
                (assoc (keygen) :green/event :delete :green/dry-run true)]]
    (let [result (start-unreadable opts)]
      (is (= 0 (:green/exit result)))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder")
          "a build must not name the operator's home directory"))))

(deftest real-create-requires-credentials
  (let [r (start (assoc (fixture) :green/event :create) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_CLOUDFLARE_API_TOKEN"))))

(deftest delete-is-protected
  (let [r (start (assoc (fixture) :green/event :delete) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COMPUTE_PREVENT_DESTROY"))))

;; --- provider switching is a rebuild, never an apply

(deftest a-provider-switch-is-refused-on-create-and-delete
  ;; The registry has one entry, so the only way to reach this is a state
  ;; recorded by a provider this package never advertised -- which is exactly
  ;; the state a delete must not render the DigitalOcean template against.
  (doseq [event [:create :delete]]
    (testing (str "DigitalOcean selected, Vultr recorded, on " (name event))
      (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                     {:provider "vultr" :ip "203.0.113.9"})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a vultr machine; set provider-compute back to vultr and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-is-accepted-on-digitalocean
  ;; A state recorded before this package wrote params.provider is a
  ;; DigitalOcean machine's -- every temporal deployment ran there -- so it
  ;; passes the switch guard and reaches the credentials on both events.
  (doseq [event [:create :delete]]
    (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                   {:ip "203.0.113.9"})]
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc (fixture) :green/event :create) {:provider "digitalocean" :ip "203.0.113.9"})]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc (fixture) :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No state stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. Green's SDK shells out
  ;; to tofu in a directory that does not exist and reports that launch
  ;; failure itself as its `tofu output failed:` step error, which ONCE's
  ;; `read-state` counts as an unreadable state, so the create reports its
  ;; credentials instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "temporal-fresh"}))]
    (try
      (let [r (sut/start-step (assoc (fixture) :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_DO_TOKEN"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest delete-fails-loudly-when-state-is-unreadable
  ;; Swallowing a failed state read is how a live teardown ended up pointing
  ;; the cleanup playbook at 192.0.2.10: stale backend credentials made
  ;; `tofu output` fail, nil was merged, and the inventory fell back to
  ;; TEST-NET. The failure must surface here, before any playbook runs, with
  ;; ONCE's wording (the old message named COLORS_PAR_IP as a way round the
  ;; read; the override no longer skips it, so the message no longer offers it).
  (let [r (start-unreadable (deletable-opts) "Unauthorized")]
    (is (= 1 (:green/exit r)))
    (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
    (is (str/includes? (:green/err r) "Unauthorized"))))

(deftest delete-with-explicit-ip-overrides-the-adopted-address-after-the-read
  ;; COLORS_PAR_IP replaces a stale recorded address; it never skips the read
  ;; or the provider guard (it used to skip the read -- that changed, because
  ;; an unreadable backend on a delete must fail, standard §4). On a readable
  ;; state the override wins over the recorded address; an unreadable backend
  ;; still fails closed with it set.
  (let [r (start (deletable-opts :ip "203.0.113.7")
                 {:provider "digitalocean" :ip "198.51.100.1" :user "root"})]
    (is (= 0 (:green/exit r)))
    (is (= "203.0.113.7" (:ip r))))
  (let [r (start-unreadable (deletable-opts :ip "203.0.113.7"))]
    (is (= 1 (:green/exit r)))
    (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))))

(deftest delete-with-empty-state-proceeds-without-an-address
  ;; State readable, no compute recorded: the instance is already gone, the
  ;; cleanup step skips itself, and the rest of the teardown still runs.
  (let [r (start (deletable-opts) nil)]
    (is (= 0 (:green/exit r)))
    (is (nil? (:ip r)))))

(deftest a-real-delete-adopts-the-recorded-address
  (let [r (start (deletable-opts) {:provider "digitalocean" :ip "203.0.113.9" :user "root"})]
    (is (= 0 (:green/exit r)))
    (is (= "203.0.113.9" (:ip r)))))

(deftest graph-order
  (is (= :temporal/infrastructure (second (sut/wire-fn :temporal/start {:green/event :create}))))
  (is (= :temporal/ssh-config (second (sut/wire-fn :temporal/infrastructure {:green/event :create}))))
  (is (= :temporal/dns (second (sut/wire-fn :temporal/ssh-config {:green/event :create}))))
  (is (= :temporal/ansible (second (sut/wire-fn :temporal/dns {:green/event :create}))))
  (is (= :temporal/acceptance (second (sut/wire-fn :temporal/ansible {:green/event :create}))))
  (is (= :temporal/ansible (second (sut/wire-fn :temporal/start {:green/event :delete})))))

(deftest delete-removes-the-config-block-before-the-destroy
  ;; The opposite of the keypair below: a block that outlives its host is
  ;; stale but harmless, so removing it early costs nothing.
  (is (= :temporal/dns (second (sut/wire-fn :temporal/ansible {:green/event :delete}))))
  (is (= :temporal/ssh-config (second (sut/wire-fn :temporal/dns {:green/event :delete}))))
  (is (= :temporal/infrastructure (second (sut/wire-fn :temporal/ssh-config {:green/event :delete}))))
  (is (some #{:temporal/ssh-config} sut/side-effecting) "a dry-run never writes ~/.ssh/config"))

(deftest delete-removes-the-key-after-the-compute-destroy
  ;; The ordering is what makes "key present <=> deployment exists" hold: a
  ;; failed destroy never reaches the cleanup step, and correctly leaves the
  ;; key that is still the only credential to whatever survived.
  (is (= :temporal/ssh-cleanup (second (sut/wire-fn :temporal/infrastructure {:green/event :delete}))))
  (is (empty? (rest (sut/wire-fn :temporal/ssh-cleanup {:green/event :delete}))))
  (is (some #{:temporal/ssh-cleanup} sut/side-effecting) "a dry-run delete touches no key"))

(deftest profile-overlay-refused
  (let [r (sut/start-step {:green/event :build} {"COLORS_PAR_PROFILE" "other"})]
    (is (= 2 (:green/exit r)))))
