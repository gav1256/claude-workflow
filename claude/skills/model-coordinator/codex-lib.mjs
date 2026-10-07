// The one module with a dynamic import. It loads the Codex skill's read-only lib (lib/binary.mjs, lib/locks.mjs, lib/usage.mjs) from
// a folder that is only known at run time. The write-surface guard pins this file's exact content by hash: change it only with a
// review, and update the hash in tests/write-surface.test.mjs. Nothing else lives here.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codexSkillDir } from "./paths.mjs";

const LIB_FNS = { binary: ["resolveCodex"], locks: ["busySlots"], usage: ["latestReading", "mapWindows", "quotaDecision"] };

/** Throws unless `href` is a file URL of lib/binary.mjs, lib/locks.mjs or lib/usage.mjs: the only modules loadCodexLib may import. */
export function assertLibHref(href) {
  if (typeof href !== "string" || !/^file:\/\/.*\/lib\/(?:binary|locks|usage)\.mjs$/.test(href) || href.includes("/../")) {
    throw new Error(`not a Codex lib module URL: ${String(href).slice(0, 120)}`);
  }
}

/**
 * resolveCodex (lib/binary.mjs), busySlots (lib/locks.mjs), latestReading, mapWindows and quotaDecision (lib/usage.mjs), merged.
 * null when the folder or a function is absent (Codex is then unavailable).
 */
export async function loadCodexLib(dir = codexSkillDir()) {
  if (!dir) return null;
  const lib = {};
  try {
    for (const [name, fns] of Object.entries(LIB_FNS)) {
      const href = pathToFileURL(path.join(dir, "lib", `${name}.mjs`)).href; // name: one of the three fixed keys of LIB_FNS
      assertLibHref(href);
      const mod = await import(href);
      for (const fn of fns) {
        if (typeof mod[fn] !== "function") return null;
        lib[fn] = mod[fn];
      }
    }
  } catch { return null; } // folder absent, or a module that does not load: Codex counts as unavailable
  return lib;
}
