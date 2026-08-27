import { describe, expect, test } from "bun:test";
import type { Opts } from "red/workflow";
import * as operator from "../src/operator.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

// --- validate ----------------------------------------------------------------

export const valid: Opts = {
  profile: "x", workdir: ".colors", "provider-compute": "digitalocean",
  "provider-dns": "cloudflare", "provider-backend": "local", "compute-prevent-destroy": true,
  "temporal-version": "1.31.2", "temporal-services": ["frontend", "history", "matching", "worker"],
  "temporal-namespace": "benchmark", "temporal-retention-days": 7,
  "temporal-typescript-sdk-version": "1.22.0", "node-version": 22, "postgres-version": 17,
  "postgres-data-dir": "/data/postgresql", "temporal-data-dir": "/data/temporal",
  "reference-application-host": "example.com", "reference-application-port": 3000,
  "reference-workflow-delay-seconds": 120, "reference-activity-failures": 2,
  "reference-activity-maximum-attempts": 5, "reference-duplicate-policy": "reject",
  "digitalocean-name": "x", "digitalocean-region": "ams3", "digitalocean-size": "c-8",
  "digitalocean-image": "ubuntu", "digitalocean-backups": true,
  "digitalocean-ssh-authorized-keys": "~/.ssh/id.pub",
  "digitalocean-ssh-sources": ["1.2.3.4/32"],
  "digitalocean-http-sources": ["0.0.0.0/0"], "digitalocean-https-sources": ["0.0.0.0/0"],
  "cloudflare-zone": "example.com", "cloudflare-proxied": false, "tls-provider": "letsencrypt",
};

describe("validate", () => {
  test("validates complete state", () => {
    expect(validate.stateErrors(valid)).toEqual([]);
  });

  test("reports all errors", () => {
    const { profile: _dropped, ...rest } = valid;
    const errors = validate.stateErrors({
      ...rest, "provider-dns": "bad",
      "digitalocean-region": "nyc3", "digitalocean-vpc-id": "invented",
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
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
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
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

  test("infrastructure renders three ingress groups", async () => {
    const data = await tools.infrastructureData({
      "red/event": "build", "digitalocean-ssh-authorized-keys": "x",
      "digitalocean-ssh-sources": ["1.2.3.4/32"],
      "digitalocean-http-sources": ["0.0.0.0/0"],
      "digitalocean-https-sources": ["0.0.0.0/0"],
    });
    expect(String(data["ssh-sources-hcl"])).toContain("1.2.3.4/32");
    expect(String(data["http-sources-hcl"])).toContain("0.0.0.0/0");
  });
});

// --- workflow ----------------------------------------------------------------

// Opts that pass real-delete preflight: guard lifted, secrets present.
function deletableOpts(overrides: Opts = {}): Opts {
  return {
    ...valid,
    "compute-prevent-destroy": false, "do-token": "t", "cloudflare-api-token": "t",
    "red/event": "delete",
    ...overrides,
  };
}

describe("workflow", () => {
  test("delete fails loudly when state is unreadable", async () => {
    // Swallowing a failed state read is how a live teardown ended up pointing
    // the cleanup playbook at 192.0.2.10: stale backend credentials made
    // `tofu output` fail, nothing was merged, and the inventory fell back to
    // TEST-NET. The failure must surface here, before any playbook runs.
    const r = await workflow.startStep(deletableOpts(), {}, async () => {
      throw new Error("Unauthorized");
    });
    expect(r["red/exit"]).toBe(1);
    expect(String(r["red/err"])).toContain("Unauthorized");
    expect(String(r["red/err"])).toContain("COLORS_PAR_IP");
  });

  test("delete with explicit ip skips the state read", async () => {
    // COLORS_PAR_IP is the operator's escape hatch when the state backend is
    // unreachable; it must not require the read it exists to replace.
    const r = await workflow.startStep(deletableOpts({ ip: "203.0.113.7" }), {}, async () => {
      throw new Error("must not be called");
    });
    expect(r["red/exit"]).toBe(0);
    expect(r.ip).toBe("203.0.113.7");
  });

  test("delete with empty state proceeds without an address", async () => {
    // State readable, no compute recorded: the instance is already gone, the
    // cleanup step skips itself, and the rest of the teardown still runs.
    const r = await workflow.startStep(deletableOpts(), {}, async () => undefined);
    expect(r["red/exit"]).toBe(0);
    expect(r.ip).toBeUndefined();
  });

  test("graph order", () => {
    expect(workflow.wireFn("temporal/start", { "red/event": "create" })?.[1])
      .toBe("temporal/infrastructure");
    expect(workflow.wireFn("temporal/start", { "red/event": "delete" })?.[1])
      .toBe("temporal/ansible");
    expect(workflow.wireFn("temporal/ansible", { "red/event": "create" })?.[1])
      .toBe("temporal/acceptance");
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
  });
});
