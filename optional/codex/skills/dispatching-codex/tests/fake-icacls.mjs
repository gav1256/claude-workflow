// A fake `icacls <dir> /T /C` for tests (a preload redirects the ACL scan's spawn here): one entry for <dir> that
// already carries the CodexSandboxUsers read deny, then the clean summary. Lists nothing real, changes nothing.
const dir = process.argv[2] ?? "C:\\x";
process.stdout.write(`${dir} CodexSandboxUsers:(OI)(CI)(DENY)(R)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
