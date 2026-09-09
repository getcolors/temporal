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
import * as compute from "../src/compute.ts";
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
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes("ams3"))).toBe(false);
  });

  test("validates secrets", () => {
    expect(validate.secretErrors(valid)).toEqual([
            "required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN",
      "required credential is not set: COLORS_PAR_R2_ACCESS_KEY_ID",
      "required credential is not set: COLORS_PAR_R2_SECRET_ACCESS_KEY",
    ]);
  });

  test("refuses profile overlay", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBeGreaterThan(0);
  });





  test("region is required but not pinned", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-region": "nyc3" }))).toEqual([]);
    expect(validate.stateErrors(fixture({ "digitalocean-region": null })))
      .toContain("invalid compute deployment requirements");
  });



  test("legacy alias conflicts are refused", () => {
    expect(validate.stateErrors(fixture({'digitalocean-ssh-authorized-keys':'~/.ssh/id_ed25519.pub'})).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({'digitalocean-https-sources':['0.0.0.0/0']}))).toEqual([]);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(keygen())).toBe(true);
    expect(validate.keygen(fixture())).toBe(false);
    // Absence, not a flag, is the switch.
    expect(validate.keygen(fixture({ "digitalocean-ssh-keys": null, "ssh-private-key-path":null }))).toBe(true);
  });











  test("backups must be a boolean", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-backups": "yes" })))
      .toContain("invalid compute deployment requirements");
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
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("compute node unavailable");
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
        ...valid, workdir, "red/event": "delete", ip: "203.0.113.7", user:"ubuntu",
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
    const s = tools.inventory({ profile: "x", ip: "192.0.2.1", user:"ubuntu" });
    expect(s).toContain("temporal");
    expect(s).toContain("192.0.2.1");
  });









  test("the provider firewall is the only firewall", () => {
    // Compute Provider Standard §5: the play manages no ufw for 22/80/443 and
    // no firewall source reaches it.
    const play = renderPlay(fixture());
    expect(play).not.toContain("ufw");
    expect(play).not.toContain("127.0.0.1/32");
    expect("ssh-source" in tools.ansibleData(fixture())).toBe(false);
  });




});

// --- ssh ---------------------------------------------------------------------

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
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7", user:"ubuntu" }));
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
    expect(render(keygen())).toContain('colors_keygen: true');
    expect(render(fixture())).toContain('colors_keygen: false');
    expect(render(fixture())).toContain('fcntl.flock');
  });
});

// --- workflow ----------------------------------------------------------------

describe("library compute", () => {
  test("all fixtures validate and use one library node", () => {
    for(const f of [keygen,fixture]) expect(validate.stateErrors(f())).toEqual([]);
    expect(compute.topology).toEqual([{role:null,count:1}]);
    expect(compute.requirements(keygen()).legacy_state_keys).toEqual(['temporal-keygen-fixture/temporal-infrastructure.tfstate']);
  });
  test("invalid compute inputs fail before execution", () => {
    for(const update of [{'provider-compute':'unsupported'},{'digitalocean-size':null},{'digitalocean-ssh-sources':[]},{'digitalocean-http-sources':['bad']}]) expect(validate.stateErrors(keygen(update)).length).toBeGreaterThan(0);
  });
  test("compute credentials are deferred to library state inspection", () => {
    const errors=validate.secretErrors(keygen()).join('\n');
    expect(errors).toContain('COLORS_PAR_CLOUDFLARE_API_TOKEN');
    expect(errors).not.toContain('COLORS_PAR_VULTR_API_KEY');
    expect(validate.tofuEnv(keygen(),'provider-compute')).toEqual({});
  });
  test("failed lifecycle diagnostics and observed node identity survive", () => {
    expect(compute.attach(keygen(),{status:'error',errors:['legacy compute state requires migration']})['red/err']).toBe('legacy compute state requires migration');
    const result=compute.attach(keygen(),{status:'present',cluster:{nodes:[{ip:'203.0.113.7',user:'ubuntu'}]},key:{private_key_path:'/tmp/explicit'}});
    expect(result.user).toBe('ubuntu');expect(result['ssh-private-key-path']).toBe('/tmp/explicit');
    expect(compute.attach(keygen(),{status:'destroyed'})['temporal/already-destroyed']).toBe(true);
    expect(()=>compute.node({cluster:{nodes:[]}})).toThrow();
  });
  test("offline start needs no credentials", async()=> {
    for(const f of [keygen,fixture]) expect((await workflow.startStep(f({'red/event':'build'}),{}))['red/exit']).toBe(0);
  });
  test("managed build and external SSH identities are deterministic",()=> {
    expect(ssh.withMachineKey(keygen({'red/event':'build'}))['ssh-private-key-path']).toBe('/home/build-placeholder/.ssh/temporal-keygen-fixture');
    expect(ssh.withMachineKey(fixture({'red/event':'build'}))).toEqual(fixture({'red/event':'build'}));
    expect(ssh.identityArgs(fixture())[1]).toBe('/home/build-placeholder/.ssh/operator-key');
  });
});

describe('owned acceptance target',()=>{
 test('state supplies IP, login and identity before execution',async()=>{
  const calls:any[]=[];
  const loader=async(opts:Opts)=>{calls.push('state');return {...opts,'red/exit':0,ip:'203.0.113.7',user:'ubuntu','ssh-private-key-path':'/tmp/operator-key'};};
  const runner=async(argv:string[])=>{calls.push(argv);return {exit:0,out:'',err:''};};
  const r=await operator.run(fixtureFile,[],runner,{},loader);
  expect(r['red/exit']).toBe(0);expect(calls[0]).toBe('state');expect(calls[1].slice(-3)).toEqual(['/tmp/operator-key','203.0.113.7','ubuntu']);
  expect(operator.acceptanceScript).not.toContain('getent');expect(operator.acceptanceScript).toContain('sudo -n -- sh -c');
 });
 test('unreadable state refuses acceptance',async()=>{
  const r=await operator.run(fixtureFile,[],async()=>{throw Error('must not execute');},{},async()=>({'red/exit':1,'red/err':'state unreadable'}));
  expect(r['red/exit']).toBe(1);expect(r['red/err']).toBe('state unreadable');
 });
});
