// Locating the native codex.exe and reading its version.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PLATFORM_PKG = "@openai/codex-win32-x64";
const EXE_REL = ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"];

function npmRoot(env) {
  if (env.CODEX_RUN_NPM_ROOT) return env.CODEX_RUN_NPM_ROOT;
  // npm is npm.cmd on Windows: it needs cmd.exe (no console window).
  const [cmd, args] = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/c", "npm", "root", "-g"]] : ["npm", ["root", "-g"]];
  return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60000 }).trim();
}

/**
 * `CODEX_RUN_BIN` (+ `CODEX_RUN_BIN_ARGS`, a JSON array) wins: tests inject the fake that way.
 * Otherwise the native binary: global `@openai/codex`, then its platform package resolved the way
 * the launcher does (createRequire from `<pkg>/bin/codex.js`; resolving from the npm root itself
 * fails with MODULE_NOT_FOUND because the platform package is nested under @openai/codex).
 * The `.cmd` shim is not used: it is not spawnable without a shell.
 */
export function resolveCodex(env = process.env) {
  if (env.CODEX_RUN_BIN) {
    let args = [];
    if (env.CODEX_RUN_BIN_ARGS) {
      try { args = JSON.parse(env.CODEX_RUN_BIN_ARGS); } catch { args = null; }
      if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
        throw new Error("CODEX_RUN_BIN_ARGS must be a JSON array of strings");
      }
    }
    return { cmd: env.CODEX_RUN_BIN, args };
  }
  const pkgDir = path.join(npmRoot(env), "@openai", "codex");
  const req = createRequire(path.join(pkgDir, "bin", "codex.js"));
  const platformPkg = req.resolve(`${PLATFORM_PKG}/package.json`);
  return { cmd: path.join(path.dirname(platformPkg), ...EXE_REL), args: [] };
}

/** "0.160.0" from `<bin> --version`. `bin` is the object resolveCodex returns. Throws if unparseable. */
export function codexVersion(bin, env = process.env) {
  const out = execFileSync(bin.cmd, [...(bin.args ?? []), "--version"], {
    env, encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`cannot read a version from: ${out.trim().slice(0, 200)}`);
  return m[1];
}

const parts = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Numeric x.y.z comparison (a pre-release suffix is ignored). Unparseable input is false. */
export function versionAtLeast(v, min = "0.159.1") {
  const a = parts(v);
  const b = parts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
