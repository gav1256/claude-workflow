// A fake `icacls <dir> [/T] [/C]` for tests (a preload redirects the spawn of icacls.exe here): one entry for <dir>, then the
// clean summary. By default the entry carries the per-user read/write/delete deny for CodexSandboxOffline and
// CodexSandboxOnline (what `--setup` asks the user to apply); FAKE_ICACLS_MODE=group-only gives it only the old group
// deny, which no longer counts. Lists nothing real, changes nothing.
const dir = process.argv[2] ?? "C:\\x";
const aces = process.env.FAKE_ICACLS_MODE === "group-only"
  ? ["TESTHOST\\CodexSandboxUsers:(OI)(CI)(DENY)(R)", "TESTHOST\\USER:(OI)(CI)(F)"]
  : ["TESTHOST\\CodexSandboxOnline:(OI)(CI)(DENY)(R,W,D)", "TESTHOST\\CodexSandboxOffline:(OI)(CI)(DENY)(R,W,D)", "TESTHOST\\USER:(OI)(CI)(F)"];
const pad = " ".repeat(dir.length + 1);
const lines = aces.map((a, i) => (i === 0 ? `${dir} ${a}` : pad + a));
process.stdout.write(`${lines.join("\r\n")}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
