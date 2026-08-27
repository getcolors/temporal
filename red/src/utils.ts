// Launcher contract and small shared helpers, the port of
// io.github.getcolors.temporal.utils.

import type { Opts } from "red/workflow";

// Bump on any change a launcher pinned to an older commit could not survive.
export const contract = 1;

export function disabledProvider(v: unknown): boolean {
  const s = String(v).toLowerCase();
  return v == null || v === false || s === "no" || s === "false" || s === "null";
}

export function provider(v: unknown): string | undefined {
  return disabledProvider(v) ? undefined : String(v).toLowerCase();
}

export function hostAlias(opts: Opts): string {
  const p = String(opts.profile ?? "");
  return p.length > 0 ? p : "temporal";
}
