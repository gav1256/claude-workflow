// A stand-in for `codex login status`. FAKE_LOGIN = chatgpt | api_key | none | garbage | hang. FAKE_STREAM = stdout (default)
// | stderr. FAKE_ENV_DUMP names a file that receives the names (not values) of the env this process got, one per line.
import fs from "node:fs";

if (process.env.FAKE_ENV_DUMP) fs.writeFileSync(process.env.FAKE_ENV_DUMP, Object.keys(process.env).join("\n"));
const out = (text) => (process.env.FAKE_STREAM === "stderr" ? process.stderr : process.stdout).write(`${text}\n`);
const args = process.argv.slice(2);
if (args.join(" ") !== "login status") { process.stderr.write(`unexpected args: ${args.join(" ")}\n`); process.exit(2); }
switch (process.env.FAKE_LOGIN) {
  case "chatgpt": out("Logged in using ChatGPT"); break;
  case "api_key": out("Logged in using an API key - sk-fake-SECRET-0000"); break;
  case "none": process.stderr.write("Not logged in\n"); process.exit(1); break;
  case "garbage": out("zzz unrelated output SECRET-GARBAGE"); break;
  case "hang": setInterval(() => {}, 1000); break;
  default: process.stderr.write("FAKE_LOGIN not set\n"); process.exit(3);
}
