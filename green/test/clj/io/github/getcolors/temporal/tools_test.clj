(ns io.github.getcolors.temporal.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.ansible :as ansible]
            [green.scaffold :as sc]
            [io.github.getcolors.temporal.tools :as sut]
            [io.github.getcolors.temporal.validate-test :as validate-test :refer [fixture keygen]]))

(defn- render-infrastructure
  "The compute template for `opts`' provider, rendered as `build` would."
  [opts]
  (sc/render-template (sut/template (str "infrastructure." (:provider-compute opts)) "main.tf")
                      (sut/infrastructure-data opts)
                      sut/template-opts))

(defn- render-play [opts]
  (sc/render-template (sut/template "ansible" "main.yml") (sut/ansible-data opts) sut/template-opts))

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

(deftest infrastructure-renders-two-ingress-groups
  ;; Formerly three: 443 now follows `digitalocean-http-sources` (Compute
  ;; Provider Standard §5) and `digitalocean-https-sources` is not read.
  (let [data (sut/infrastructure-data
              (fixture :green/event :build
                       :digitalocean-ssh-sources ["1.2.3.4/32"]
                       :digitalocean-http-sources ["0.0.0.0/0"]
                       :digitalocean-https-sources ["198.51.100.0/24"]))]
    (is (str/includes? (:ssh-sources-hcl data) "1.2.3.4/32"))
    (is (str/includes? (:http-sources-hcl data) "0.0.0.0/0"))
    (is (not (contains? data :https-sources-hcl)))
    (is (not (str/includes? (render-infrastructure (fixture :digitalocean-https-sources ["198.51.100.0/24"]))
                            "198.51.100.0/24")))))

(deftest infrastructure-data-carries-the-name-and-the-keypair-mode
  ;; One resolved name and one mode reach every template, so no template
  ;; branches on the provider or re-derives either. No fingerprint is shelled
  ;; out for: the key model is the standard's.
  (let [data (sut/infrastructure-data (fixture))]
    (is (= "temporal-fixture" (:compute-name data)))
    (is (false? (:ssh-keygen data)))
    (is (not (contains? data :digitalocean-ssh-key-fingerprint))))
  (let [data (sut/infrastructure-data (keygen))]
    (is (= "temporal-keygen-fixture" (:compute-name data)))
    (is (true? (:ssh-keygen data))))
  (is (true? (:ssh-keygen (sut/ansible-data (keygen)))))
  (is (false? (:ssh-keygen (sut/ansible-data (fixture))))))

(deftest template-names-the-machine-from-one-resolved-value
  ;; Droplet name, firewall name and params.name interpolate compute-name,
  ;; never `digitalocean-name` or the profile directly, so an override and
  ;; the fallback land everywhere at once.
  (let [template (slurp "src/resources/io/github/getcolors/temporal/tools/infrastructure/digitalocean/main.tf")]
    (is (not (str/includes? template "<{ digitalocean-name }>")))
    (is (str/includes? template "name     = \"<{ compute-name }>\""))
    (is (str/includes? template "name        = \"<{ compute-name }>-firewall\""))
    (is (str/includes? template "provider = \"digitalocean\""))
    (is (not (str/includes? template "https-sources"))))
  (let [rendered (render-infrastructure (fixture :digitalocean-name "custom-label"))]
    (is (str/includes? rendered "name     = \"custom-label\""))
    (is (str/includes? rendered "name        = \"custom-label-firewall\""))
    (is (str/includes? rendered "name = \"custom-label\""))))

(deftest keygen-mode-declares-the-key-resource-and-opt-out-keeps-the-literal
  (testing "keygen"
    (let [rendered (render-infrastructure (assoc (sut/infrastructure-data (keygen))
                                                 :ssh-public-key-path "/home/build-placeholder/.ssh/temporal-keygen-fixture.pub"))]
      (is (str/includes? rendered "resource \"digitalocean_ssh_key\" \"machine\""))
      (is (str/includes? rendered "name       = \"temporal-keygen-fixture\""))
      (is (str/includes? rendered "ssh_keys = [digitalocean_ssh_key.machine.id]"))
      (is (str/includes? rendered "ssh_key_id = digitalocean_ssh_key.machine.id"))
      (is (not (str/includes? rendered "digitalocean_ssh_keys")))))
  (testing "opt-out"
    (let [rendered (render-infrastructure (fixture))]
      (is (not (str/includes? rendered "digitalocean_ssh_key")))
      (is (str/includes? rendered "ssh_keys = [\"00000000\"]"))
      (is (not (str/includes? rendered "ssh_key_id"))))))

(deftest the-provider-firewall-is-the-only-firewall
  ;; Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
  ;; no firewall source reaches it.
  (let [play (render-play (fixture))]
    (is (not (str/includes? play "ufw")))
    (is (not (str/includes? play "127.0.0.1/32"))))
  (is (not (contains? (sut/ansible-data (fixture)) :ssh-source))))

(deftest empty-http-sources-renders-no-public-http
  ;; An empty `digitalocean-http-sources` is allowed and means no public
  ;; HTTP: the 80/443 rules are a dynamic block over an empty list, because
  ;; DigitalOcean rejects an inbound rule with no source as an API error
  ;; rather than a closed port. SSH stays.
  (let [rendered (render-infrastructure (fixture :digitalocean-http-sources []))]
    (is (str/includes? rendered "length([]) > 0 ? ["))
    (is (str/includes? rendered "source_addresses = []"))
    (is (str/includes? rendered "port_range       = \"22\"")))
  (let [rendered (render-infrastructure (fixture))]
    (is (str/includes? rendered "length([\"0.0.0.0/0\", \"::/0\"]) > 0 ? ["))
    (is (str/includes? rendered "{ protocol = \"tcp\", port_range = \"443\" }"))
    (is (not (str/includes? rendered "udp\", port_range")))))

(deftest a-missing-compute-output-fails-loudly
  ;; The documentation address belongs to build and dry-run. Merging it into a
  ;; real converge would point Ansible at TEST-NET instead of failing.
  (is (= "1.2.3.4" (:ip (sut/resolved-compute {} {:ip "192.0.2.10"} {:ip "1.2.3.4"}))))
  (is (= 1 (:green/exit (sut/resolved-compute {} {:ip "192.0.2.10"} nil))))
  (is (str/includes? (:green/err (sut/resolved-compute {} {:ip "192.0.2.10"} {}))
                     "compute produced no ip output"))
  (is (= "digitalocean" (:provider (sut/fallback-params (fixture))))))
