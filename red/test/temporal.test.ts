import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate } from "red/scaffold";
import { StepError, type Opts } from "red/workflow";
import * as operator from "../src/operator.ts";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const keygenFile = join(import.meta.dir, "../../test/fixtures/keygen.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

// DigitalOcean in opt-out mode (an explicit key id, a name equal to the
// profile) and in keygen mode (no `digitalocean-ssh-keys`, no
// `digitalocean-name`).
const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const keygen = (overrides: Opts = {}) => readFixture(keygenFile, overrides);

// The historical inline valid map, kept so the older tests read as they did.
export const valid: Opts = fixture({
  profile: "x", "digitalocean-name": "x", "digitalocean-image": "ubuntu",
  "digitalocean-ssh-sources": ["1.2.3.4/32"], "digitalocean-http-sources": ["0.0.0.0/0"],
});

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home. Nothing here may touch the real one.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "temporal-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The compute template for `opts`' provider, rendered as `build` would.
function renderInfrastructure(opts: Opts): string {
  return renderTemplate(tools.template(`infrastructure.${opts["provider-compute"]}`, "main.tf"),
    tools.infrastructureData(opts), tools.templateOpts);
}

function renderPlay(opts: Opts): string {
  return renderTemplate(tools.template("ansible", "main.yml"), tools.ansibleData(opts), tools.templateOpts);
}

const resource = (name: string) =>
  readFileSync(join(import.meta.dir, "../resources", name), "utf8");

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("validates complete state", () => {
    expect(validate.stateErrors(valid)).toEqual([]);
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(keygen())).toEqual([]);
  });

  test("reports all errors", () => {
    // The `digitalocean-region: nyc3` override no longer counts: the hardcoded
    // ams3 check went with the Compute Provider Standard (the registry
    // requires presence only), so an empty SSH list takes its place.
    const { profile: _dropped, ...rest } = valid;
    const errors = validate.stateErrors({
      ...rest, "provider-dns": "bad",
      "digitalocean-region": "nyc3", "digitalocean-ssh-sources": [],
      "digitalocean-vpc-id": "invented",
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some((e) => e.includes("ams3"))).toBe(false);
  });

  test("validates secrets", () => {
    expect(validate.secretErrors(valid)).toEqual([
      "required credential is not set: COLORS_PAR_DO_TOKEN",
      "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
    ]);
  });

  test("refuses profile overlay", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBeGreaterThan(0);
  });

  test("the spec carries this package's registry, sources and default", () => {
    // The operations are ONCE's; this is the data they run over. A colour
    // whose registry, sources or default drifts fails here, in that colour.
    expect(Object.keys(validate.spec.registry)).toEqual(["digitalocean"]);
    expect(validate.spec.registry).toBe(validate.computeProviders);
    expect(validate.spec.registry.digitalocean).toEqual({
      required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                 "digitalocean-backups", "digitalocean-ssh-sources",
                 "digitalocean-http-sources"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    });
    expect(validate.spec.sources).toEqual({ nonEmpty: ["ssh-sources"], mayBeEmpty: ["http-sources"] });
    // DigitalOcean: the default is what a legacy state without
    // params.provider is, and every deployment this package made ran there.
    expect(validate.spec.default).toBe("digitalocean");
    expect(validate.spec.default).toBe(validate.defaultComputeProvider);
    expect("nameRules" in validate.spec).toBe(false);
  });

  test("compute provider must be one the package has a template for", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "vultr" })))
      .toContain(":provider-compute must be one of digitalocean");
  });

  test("region is required but not pinned", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-region": "nyc3" }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "digitalocean-region": null })))
      .toContain(":digitalocean-region is required");
  });

  test("name and machine key are never required", () => {
    for (const key of validate.computeProviders.digitalocean!.required) {
      expect(key.endsWith("-name")).toBe(false);
      expect(key.endsWith("-ssh-keys")).toBe(false);
    }
    expect(validate.stateErrors(fixture({ "digitalocean-name": null, "digitalocean-ssh-keys": null }))).toEqual([]);
  });

  test("retired keys are accepted and ignored", () => {
    // `digitalocean-ssh-authorized-keys` (the pre-standard fingerprint path)
    // and `digitalocean-https-sources` (443 now follows http-sources) are
    // neither required nor read; a colors.yml that still carries them
    // validates, and absence of the retired key is not what selects keygen.
    expect(validate.stateErrors(fixture({
      "digitalocean-ssh-authorized-keys": "~/.ssh/id_ed25519.pub",
      "digitalocean-https-sources": ["0.0.0.0/0"],
    }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-authorized-keys": "x", "digitalocean-ssh-keys": null })))
      .toEqual([]);
    expect(validate.keygen(fixture({ "digitalocean-ssh-authorized-keys": null }))).toBe(false);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(keygen())).toBe(true);
    expect(validate.keygen(fixture())).toBe(false);
    // Absence, not a flag, is the switch.
    expect(validate.keygen(fixture({ "digitalocean-ssh-keys": null }))).toBe(true);
  });

  test("compute name falls back to the profile", () => {
    expect(validate.computeName(fixture())).toBe("temporal-fixture");
    expect(validate.computeName(keygen())).toBe("temporal-keygen-fixture");
    expect(validate.computeName(fixture({ "digitalocean-name": "custom" }))).toBe("custom");
    expect(validate.computeKey(fixture(), "ssh-sources")).toBe("digitalocean-ssh-sources");
  });

  test("compute credentials follow the provider", () => {
    expect(validate.tofuEnv(fixture(), "provider-compute")).toEqual({ "do-token": "DIGITALOCEAN_TOKEN" });
    expect(validate.tofuEnv(fixture({ "provider-compute": "vultr" }), "provider-compute")).toEqual({});
  });

  test("ssh sources must not be empty; no public HTTP is fine", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })))
      .toContain(":digitalocean-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": [] }))).toEqual([]);
  });

  test("malformed sources are refused before any provider call", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": ["0.0.0.0/0", "nope"] })))
      .toContain(':digitalocean-ssh-sources entry "nope" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "digitalocean-http-sources": ["203.0.113.0"] })))
      .toContain(':digitalocean-http-sources entry "203.0.113.0" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": ["2001:db8::/32", "203.0.113.4/32"] })))
      .toEqual([]);
  });

  test("forbids vpc configuration: ONCE's two and this package's two", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "forbidden" }))
      .some((e) => e.includes("vpc-uuid"))).toBe(true);
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-cidr": "10.0.0.0/16" }))
      .some((e) => e.includes("must be absent"))).toBe(true);
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-id": "invented" })))
      .toContain(":digitalocean-vpc-id must not be configured; the default regional VPC is discovered at runtime");
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-name": "invented" }))
      .some((e) => e.includes("vpc-name"))).toBe(true);
  });

  test("backups must be a boolean", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-backups": "yes" })))
      .toContain(":digitalocean-backups must be true or false");
  });

  test("keeps the package's own checks", () => {
    expect(validate.stateErrors(fixture({ "temporal-services": ["worker", "frontend", "history", "matching"] }))
      .some((e) => e.includes("in that order"))).toBe(true);
    expect(validate.stateErrors(fixture({ "reference-application-host": "api.example.com" }))
      .some((e) => e.includes("zone apex"))).toBe(true);
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("delete cleanup skips when state has no compute", async () => {
    // With the instance already gone the inventory would render 192.0.2.10;
    // there is no host to reach, so the step must not run the playbook and the
    // teardown must continue past it.
    const r = await tools.ansibleStep({ ...valid, "red/event": "delete" });
    expect(r["red/exit"]).toBe(0);
    expect(r["temporal/cleanup"]).toBe("skipped-no-compute");
  });

  test("delete cleanup targets the adopted address", async () => {
    // When the start step recovered the instance address from state, the
    // cleanup playbook runs against it, never the documentation fallback.
    const { runtime } = await import("red/runtime");
    const workdir = mkdtempSync(join(tmpdir(), "temporal-red-test-"));
    const original = runtime.exec;
    const commands: string[][] = [];
    // The rendered tree is removed again after a successful cleanup, so the
    // inventory must be captured at the moment the playbook would run.
    let inventoryAtRun = "";
    runtime.exec = async (cmd) => {
      commands.push(cmd);
      if (cmd[0] === "ansible-playbook") {
        inventoryAtRun = readFileSync(
          join(workdir, "x", "temporal-ansible", "inventory.json"), "utf8");
      }
      return { exit: 0, out: "", err: "" };
    };
    try {
      const r = await tools.ansibleStep({
        ...valid, workdir, "red/event": "delete", ip: "203.0.113.7",
      });
      expect(r["red/exit"]).toBe(0);
      expect(commands.some((cmd) => cmd[0] === "ansible-playbook")).toBe(true);
      expect(inventoryAtRun).toContain("203.0.113.7");
    } finally {
      runtime.exec = original;
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("inventory has private target", () => {
    const s = tools.inventory({ profile: "x", ip: "192.0.2.1" });
    expect(s).toContain("temporal");
    expect(s).toContain("192.0.2.1");
  });

  test("infrastructure renders two ingress groups", () => {
    // Formerly three: 443 now follows `digitalocean-http-sources` (Compute
    // Provider Standard §5) and `digitalocean-https-sources` is not read.
    const data = tools.infrastructureData(fixture({
      "red/event": "build",
      "digitalocean-ssh-sources": ["1.2.3.4/32"],
      "digitalocean-http-sources": ["0.0.0.0/0"],
      "digitalocean-https-sources": ["198.51.100.0/24"],
    }));
    expect(String(data["ssh-sources-hcl"])).toContain("1.2.3.4/32");
    expect(String(data["http-sources-hcl"])).toContain("0.0.0.0/0");
    expect("https-sources-hcl" in data).toBe(false);
    expect(renderInfrastructure(fixture({ "digitalocean-https-sources": ["198.51.100.0/24"] })))
      .not.toContain("198.51.100.0/24");
  });

  test("infrastructure data carries the name and the keypair mode", () => {
    // One resolved name and one mode reach every template; no fingerprint is
    // shelled out for: the key model is the standard's.
    const optout = tools.infrastructureData(fixture());
    expect(optout["compute-name"]).toBe("temporal-fixture");
    expect(optout["ssh-keygen"]).toBe(false);
    expect("digitalocean-ssh-key-fingerprint" in optout).toBe(false);
    const generated = tools.infrastructureData(keygen());
    expect(generated["compute-name"]).toBe("temporal-keygen-fixture");
    expect(generated["ssh-keygen"]).toBe(true);
    expect(tools.ansibleData(keygen())["ssh-keygen"]).toBe(true);
    expect(tools.ansibleData(fixture())["ssh-keygen"]).toBe(false);
  });

  test("the template names the machine from one resolved value", () => {
    const template = resource("tools/infrastructure/digitalocean/main.tf");
    expect(template).not.toContain("<{ digitalocean-name }>");
    expect(template).toContain('name     = "<{ compute-name }>"');
    expect(template).toContain('name        = "<{ compute-name }>-firewall"');
    expect(template).toContain('provider = "digitalocean"');
    expect(template).not.toContain("https-sources");
    const rendered = renderInfrastructure(fixture({ "digitalocean-name": "custom-label" }));
    expect(rendered).toContain('name     = "custom-label"');
    expect(rendered).toContain('name        = "custom-label-firewall"');
    expect(rendered).toContain('name = "custom-label"');
  });

  test("keygen mode declares the key resource and opt-out keeps the literal", () => {
    const generated = renderTemplate(tools.template("infrastructure.digitalocean", "main.tf"), {
      ...tools.infrastructureData(keygen()),
      "ssh-public-key-path": "/home/build-placeholder/.ssh/temporal-keygen-fixture.pub",
    }, tools.templateOpts);
    expect(generated).toContain('resource "digitalocean_ssh_key" "machine"');
    expect(generated).toContain('name       = "temporal-keygen-fixture"');
    expect(generated).toContain("ssh_keys = [digitalocean_ssh_key.machine.id]");
    expect(generated).toContain("ssh_key_id = digitalocean_ssh_key.machine.id");
    expect(generated).not.toContain("digitalocean_ssh_keys");
    const optout = renderInfrastructure(fixture());
    expect(optout).not.toContain("digitalocean_ssh_key");
    expect(optout).toContain('ssh_keys = ["00000000"]');
    expect(optout).not.toContain("ssh_key_id");
  });

  test("the provider firewall is the only firewall", () => {
    // Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
    // no firewall source reaches it.
    const play = renderPlay(fixture());
    expect(play).not.toContain("ufw");
    expect(play).not.toContain("127.0.0.1/32");
    expect("ssh-source" in tools.ansibleData(fixture())).toBe(false);
  });

  test("empty http sources render no public HTTP", () => {
    // The 80/443 rules are a dynamic block over an empty list, because
    // DigitalOcean rejects an inbound rule with no source as an API error
    // rather than a closed port. SSH stays.
    const empty = renderInfrastructure(fixture({ "digitalocean-http-sources": [] }));
    expect(empty).toContain("length([]) > 0 ? [");
    expect(empty).toContain("source_addresses = []");
    expect(empty).toContain('port_range       = "22"');
    const full = renderInfrastructure(fixture());
    expect(full).toContain('length(["0.0.0.0/0", "::/0"]) > 0 ? [');
    expect(full).toContain('{ protocol = "tcp", port_range = "443" }');
    expect(full).not.toContain('udp", port_range');
  });

  test("a missing compute output fails loudly", () => {
    expect(tools.resolvedCompute({}, { ip: "192.0.2.10" }, { ip: "1.2.3.4" }).ip).toBe("1.2.3.4");
    expect(tools.resolvedCompute({}, { ip: "192.0.2.10" }, undefined)["red/exit"]).toBe(1);
    expect(String(tools.resolvedCompute({}, { ip: "192.0.2.10" }, {})["red/err"]))
      .toContain("compute produced no ip output");
    expect(tools.fallbackParams(fixture()).provider).toBe("digitalocean");
  });
});

// --- ssh ---------------------------------------------------------------------

describe("ssh", () => {
  // The matrix itself is ONCE's and tested there; these prove the delegation
  // with this package's fixtures.
  test("build renders a stable placeholder path", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "build" }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    expect(opts["digitalocean-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect(String(opts["ssh-private-key-path"])).not.toContain(home);
    const optedOut = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(optedOut["digitalocean-ssh-keys"]).toBe("00000000");
    expect(optedOut["ssh-public-key-path"]).toBeUndefined();
  });

  test("a dry-run renders the placeholder too; real events render the real path", () => {
    const dry = ssh.withMachineKey(keygen({ "red/event": "create", "red/dry-run": true }));
    expect(String(dry["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    const real = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(real["ssh-private-key-path"]).toBe(join(home, ".ssh", "temporal-keygen-fixture"));
    expect(real["ssh-public-key-path"]).toBe(join(home, ".ssh", "temporal-keygen-fixture.pub"));
  });

  test("opt-out passes through untouched", () => {
    for (const event of ["build", "create", "delete"]) {
      const opts = ssh.withMachineKey(fixture({ "red/event": event }));
      expect(opts["digitalocean-ssh-keys"]).toBe("00000000");
      expect(opts["ssh-public-key-path"]).toBeUndefined();
      expect(opts["ssh-keygen"]).toBeUndefined();
    }
  });

  test("identity args select the generated key only in keygen mode", () => {
    const opts = ssh.withMachineKey(keygen({ "red/event": "create" }));
    expect(ssh.identityArgs(opts)).toEqual(["-o", "IdentitiesOnly=yes", "-i", String(opts["ssh-private-key-path"])]);
    expect(ssh.privateKeyPath(opts)).toBe(join(home, ".ssh", "temporal-keygen-fixture"));
    expect(ssh.identityArgs(ssh.withMachineKey(fixture({ "red/event": "create" })))).toEqual([]);
  });

  test("first create generates the keypair", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    const prv = join(home, ".ssh", "temporal-keygen-fixture");
    const pub = `${prv}.pub`;
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(prv)).toBe(true);
    expect(existsSync(pub)).toBe(true);
    expect(readFileSync(pub, "utf8")).toContain("ssh-ed25519");
    expect(readFileSync(pub, "utf8")).toContain("temporal-keygen-fixture managed by Colors");
    expect(statSync(prv).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  test("a key without state is never overwritten", async () => {
    const prv = join(home, ".ssh", "temporal-keygen-fixture");
    write(prv, "irreplaceable");
    write(`${prv}.pub`, "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("no compute state is readable");
    expect(String(opts["red/err"])).toContain("survives");
    expect(readFileSync(prv, "utf8")).toBe("irreplaceable");
  });

  test("state without a key is an error", async () => {
    const opts = await ssh.ensureKey(keygen({ "red/event": "create" }), async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("does not hold the machine key");
  });

  test("opt-out generates nothing", async () => {
    const result = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(result["red/err"]).toBeUndefined();
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  test("preflight lists keys with the DigitalOcean token", async () => {
    const seen: Array<[string, string]> = [];
    const capture = async (provider: string, token: string) => { seen.push([provider, token]); return []; };
    await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create", "do-token": "do-secret" })), capture);
    expect(seen).toEqual([["digitalocean", "do-secret"]]);
  });

  test("preflight refuses a foreign key and says do not delete it", async () => {
    write(join(home, ".ssh", "temporal-keygen-fixture.pub"), "ssh-ed25519 OURS comment");
    const opts = await ssh.preflight(ssh.withMachineKey(keygen({ "red/event": "create" })),
      async () => [{ id: "abc", name: "temporal-keygen-fixture", public: "ssh-ed25519 THEIRS" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("Do not delete it");
  });

  test("preflight is skipped in opt-out mode", async () => {
    const opts = await ssh.preflight(fixture({ "red/event": "create" }),
      async () => { throw new Error("must not be called"); });
    expect(opts["red/err"]).toBeUndefined();
  });

  test("delete removes the keypair; ~/.ssh itself survives; cleanup is otherwise inert", () => {
    write(join(home, ".ssh", "temporal-keygen-fixture"), "private");
    write(join(home, ".ssh", "temporal-keygen-fixture.pub"), "public");
    ssh.cleanupStep(keygen({ "red/event": "create", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "temporal-keygen-fixture"))).toBe(true);
    ssh.cleanupStep(fixture({ "red/event": "delete" }));
    expect(existsSync(join(home, ".ssh", "temporal-keygen-fixture"))).toBe(true);
    ssh.cleanupStep(keygen({ "red/event": "delete", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "temporal-keygen-fixture"))).toBe(false);
    expect(existsSync(join(home, ".ssh", "temporal-keygen-fixture.pub"))).toBe(false);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
  });
});

// --- ssh-config --------------------------------------------------------------

describe("ssh-config", () => {
  const configFile = () => join(home, ".ssh", "config");

  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("temporal-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/temporal-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone, and owned-markers holds only it", () => {
    expect(sshConfig.beginMarker("temporal-digitalocean")).toBe("# BEGIN temporal-digitalocean ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("temporal-digitalocean")).toBe("# END temporal-digitalocean ANSIBLE MANAGED BLOCK");
    const owned = sshConfig.ownedMarkers("temporal-digitalocean");
    expect([...owned.begin]).toEqual(["# BEGIN temporal-digitalocean ANSIBLE MANAGED BLOCK"]);
    expect([...owned.end]).toEqual(["# END temporal-digitalocean ANSIBLE MANAGED BLOCK"]);
  });

  test("host patterns are read from a Host line", () => {
    expect(sshConfig.hostPatterns("Host temporal-fixture")).toEqual(["temporal-fixture"]);
    expect(sshConfig.hostPatterns("  host   web temporal-fixture  db ")).toEqual(["web", "temporal-fixture", "db"]);
    expect(sshConfig.hostPatterns("    HostName 192.0.2.1")).toBeUndefined();
    expect(sshConfig.hostPatterns("Match host temporal-fixture")).toBeUndefined();
  });

  test("a foreign stanza is found; our own block is not foreign; after our block is still foreign", () => {
    const alias = "temporal-fixture";
    expect(sshConfig.foreignStanzaLine(["Host other", "    HostName 192.0.2.1", "", `Host ${alias}`], alias)).toBe(4);
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1", sshConfig.endMarker(alias)], alias))
      .toBeUndefined();
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias), `Host ${alias}`], alias)).toBe(4);
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN temporal ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`, `# END temporal ${alias} ANSIBLE MANAGED BLOCK`], alias))
      .toBe(2);
    expect(sshConfig.foreignStanzaLine(["Host web temporal-fixture db"], alias)).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host temporal-other"], alias)).toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), { adoptError: () => undefined, placementError: () => undefined });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt and placement errors name the file and the line", () => {
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
    write(configFile(), "Host other\n    HostName 192.0.2.1\n\nHost temporal-fixture\n    User root\n");
    const adopt = String(sshConfig.adoptError(fixture()));
    expect(adopt).toContain(configFile());
    expect(adopt).toContain("`Host temporal-fixture` at line 4");
    expect(adopt).toContain("will not overwrite it");
    const alias = "temporal-fixture";
    write(configFile(), `${sshConfig.beginMarker(alias)}\nHost ${alias}\n    HostName 192.0.2.1\n${sshConfig.endMarker(alias)}\n`);
    expect(sshConfig.adoptError(fixture())).toBeUndefined();
    write(configFile(), "# comment\n\n\nIdentitiesOnly yes\nHost a\n");
    const placement = String(sshConfig.placementError(fixture()));
    expect(placement).toContain(configFile());
    expect(placement).toContain("line 4");
    expect(placement).toContain("Host *");
  });

  test("preflight reads the redirected file end to end", () => {
    write(configFile(), "Host temporal-fixture\n    HostName 192.0.2.1\n");
    const refused = sshConfig.preflight(fixture());
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    write(configFile(), "ServerAliveInterval 60\nHost a\n");
    const placed = sshConfig.preflight(fixture());
    expect(placed["red/exit"]).toBe(1);
    expect(String(placed["red/err"])).toContain("line 1");
    write(configFile(), "Host a\n    User root\n");
    expect(sshConfig.preflight(fixture())["red/exit"]).toBeUndefined();
  });

  test("build and dry-run never read the config", async () => {
    // A leading-option file that would refuse a real create must not disturb
    // a build or a dry-run.
    write(configFile(), "ServerAliveInterval 60\nHost temporal-fixture\n");
    for (const opts of [fixture({ "red/event": "build" }),
                        keygen({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true })]) {
      expect((await workflow.startStep(opts, {}))["red/exit"]).toBe(0);
    }
  });

  test("the local stage renders three address-free files following keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/temporal-fixture");
    expect(data["ssh-keygen"]).toBe(false);
    expect(tools.ansibleLocalData(keygen())["ssh-keygen"]).toBe(true);
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("temporal-ansible-local"))).toBe(true);
    const render = (opts: Opts) =>
      renderTemplate(tools.template("ansible-local", "main.yml"), tools.ansibleLocalData(opts), tools.templateOpts);
    const keygenPlay = render(keygen());
    expect(keygenPlay).toContain("IdentityFile ~/.ssh/temporal-keygen-fixture");
    expect(keygenPlay).toContain("IdentitiesOnly yes");
    const optoutPlay = render(fixture());
    expect(optoutPlay).not.toContain("IdentityFile ~/.ssh/");
    expect(optoutPlay).not.toContain("IdentitiesOnly yes");
    for (const play of [keygenPlay, optoutPlay]) {
      expect(play).toContain("insertbefore: BOF");
      expect(play).toContain("HostName {{ ip }}");
      expect(play).toContain("Host {{ host_alias }}");
      expect(play).toContain("StrictHostKeyChecking accept-new");
      expect(play).not.toMatch(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
    }
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  // The compute state is read once per run, through the injectable reader,
  // on a real create or delete. Every lifecycle test stubs it: undefined is a
  // readable state holding no compute, a map is a recorded `params`, and a
  // throw is a backend that cannot be read.
  const start = (opts: Opts, state: Record<string, unknown> | undefined) =>
    workflow.startStep(opts, {}, async () => state);
  // The shape `red/tofu` throws: the SDK's StepError. Only that is an
  // unreadable backend; anything else propagates as a defect.
  const startUnreadable = (opts: Opts, message = "tofu output failed: no backend") =>
    workflow.startStep(opts, {}, async () => { throw new StepError(message); });

  // Opts that pass real-delete preflight: guard lifted, secrets present.
  const deletableOpts = (overrides: Opts = {}) => ({
    ...valid, "compute-prevent-destroy": false, "do-token": "t", "cloudflare-api-token": "t",
    "red/event": "delete", ...overrides,
  });

  test("build and dry-run need no credentials and never touch ~/.ssh or the state", async () => {
    expect((await workflow.startStep(fixture({ "red/event": "build" }), {}))["red/exit"]).toBe(0);
    expect((await workflow.startStep(fixture({ "red/event": "create", "red/dry-run": true }), {}))["red/exit"]).toBe(0);
    for (const opts of [keygen({ "red/event": "build" }),
                        keygen({ "red/event": "create", "red/dry-run": true }),
                        keygen({ "red/event": "delete", "red/dry-run": true })]) {
      const result = await startUnreadable(opts);
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("a real create requires credentials; delete is protected", async () => {
    const create = await start(fixture({ "red/event": "create" }), undefined);
    expect(create["red/exit"]).toBe(2);
    expect(String(create["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
    expect(String(create["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    const del = await start(fixture({ "red/event": "delete" }), undefined);
    expect(del["red/exit"]).toBe(2);
    expect(String(del["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
  });

  test("a provider switch is refused on create and delete", async () => {
    for (const event of ["create", "delete"]) {
      const r = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "vultr", ip: "203.0.113.9" });
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"]))
        .toContain("state holds a vultr machine; set provider-compute back to vultr and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(r["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state is accepted on digitalocean", async () => {
    for (const event of ["create", "delete"]) {
      const r = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }), { ip: "203.0.113.9" });
      expect(String(r["red/err"])).not.toContain("state holds");
      expect(String(r["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const r = await start(fixture({ "red/event": "create" }), { provider: "digitalocean", ip: "203.0.113.9" });
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("an unreadable backend counts as no state on create", async () => {
    const r = await startUnreadable(fixture({ "red/event": "create" }));
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("could not read");
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does.
    const work = mkdtempSync(join(tmpdir(), "temporal-red-fresh"));
    try {
      const r = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }), {});
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
      expect(String(r["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("delete fails loudly when state is unreadable", async () => {
    // Swallowing a failed state read is how a live teardown ended up pointing
    // the cleanup playbook at 192.0.2.10. The failure must surface here, with
    // ONCE's wording (the old message named COLORS_PAR_IP as a way round the
    // read; the override no longer skips it, so the message no longer offers it).
    const r = await startUnreadable(deletableOpts(), "Unauthorized");
    expect(r["red/exit"]).toBe(1);
    expect(String(r["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(r["red/err"])).toContain("Unauthorized");
  });

  test("delete with an explicit ip overrides the adopted address after the read", async () => {
    // COLORS_PAR_IP replaces a stale recorded address; it never skips the read
    // or the provider guard (it used to skip the read — that changed). On a
    // readable state the override wins; an unreadable backend still fails
    // closed with it set.
    const adopted = await start(deletableOpts({ ip: "203.0.113.7" }),
      { provider: "digitalocean", ip: "198.51.100.1", user: "root" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("203.0.113.7");
    const unreadable = await startUnreadable(deletableOpts({ ip: "203.0.113.7" }));
    expect(unreadable["red/exit"]).toBe(1);
    expect(String(unreadable["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
  });

  test("delete with empty state proceeds without an address", async () => {
    const r = await start(deletableOpts(), undefined);
    expect(r["red/exit"]).toBe(0);
    expect(r.ip).toBeUndefined();
  });

  test("a real delete adopts the recorded address", async () => {
    const r = await start(deletableOpts(), { provider: "digitalocean", ip: "203.0.113.9", user: "root" });
    expect(r["red/exit"]).toBe(0);
    expect(r.ip).toBe("203.0.113.9");
  });

  test("graph order", () => {
    const next = (step: string, event: string) =>
      (workflow.wireFn(step, { "red/event": event }) ?? []).slice(1);
    expect(next("temporal/start", "create")).toEqual(["temporal/infrastructure"]);
    expect(next("temporal/infrastructure", "create")).toEqual(["temporal/ssh-config"]);
    expect(next("temporal/ssh-config", "create")).toEqual(["temporal/dns"]);
    expect(next("temporal/dns", "create")).toEqual(["temporal/ansible"]);
    expect(next("temporal/ansible", "create")).toEqual(["temporal/acceptance"]);
    expect(next("temporal/start", "delete")).toEqual(["temporal/ansible"]);
  });

  test("delete removes the config block before the destroy and the key after it", () => {
    const next = (step: string) => (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("temporal/ansible")).toEqual(["temporal/dns"]);
    expect(next("temporal/dns")).toEqual(["temporal/ssh-config"]);
    expect(next("temporal/ssh-config")).toEqual(["temporal/infrastructure"]);
    expect(next("temporal/infrastructure")).toEqual(["temporal/ssh-cleanup"]);
    expect(next("temporal/ssh-cleanup")).toEqual([]);
    expect(workflow.sideEffecting).toContain("temporal/ssh-config");
    expect(workflow.sideEffecting).toContain("temporal/ssh-cleanup");
  });

  test("profile overlay refused", async () => {
    const r = await workflow.startStep({ "red/event": "build" }, { COLORS_PAR_PROFILE: "other" });
    expect(r["red/exit"]).toBe(2);
  });
});

// --- operator ----------------------------------------------------------------

describe("operator", () => {
  test("acceptance script covers required behavior", () => {
    expect(operator.acceptanceScript).toMatch(/healthz/);
    expect(operator.acceptanceScript).toMatch(/409/);
    expect(operator.acceptanceScript).toMatch(/attempts/);
    expect(operator.acceptanceScript).toMatch(/systemctl reboot/);
    expect(operator.acceptanceScript).toMatch(/systemctl restart docker/);
    // Keygen mode: the deployment's own key is the machine's only access key.
    expect(operator.acceptanceScript).toMatch(/IdentitiesOnly=yes -i/);
  });
});
