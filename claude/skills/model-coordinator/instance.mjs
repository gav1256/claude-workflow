// Single instance: one coordinator per machine. The lock is a named pipe (an OS object freed when its holder dies, however it
// dies; the same pattern as lib/locks.mjs acquirePipe in the Codex skill). instance.json (through the store) says who holds it, so
// a second start can name the holder. The pipe, not the file, decides: a stale instance.json never blocks a start.
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";
import { stateDir } from "./paths.mjs";
import * as store from "./store.mjs";

const pipePath = (name) => `\\\\.\\pipe\\${name}`;

/** {pid, started_at} from instance.json, or null when it is absent, unreadable or not in that shape. */
export function readInstance() {
  try {
    const o = JSON.parse(readFileSync(path.join(stateDir(), "instance.json"), "utf8"));
    if (o && Number.isInteger(o.pid) && o.pid > 0 && typeof o.started_at === "string") return { pid: o.pid, started_at: o.started_at };
  } catch { /* no usable record */ }
  return null;
}

/**
 * -> {server} when this process now holds the instance (instance.json is written), or {taken: {pid, started_at} | null} when
 * another process holds it (null: the holder left no readable instance.json). Any other listen error rejects.
 */
export function acquireInstance(name = process.env.MC_PIPE_NAME || "model-coordinator") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (e) => (e.code === "EADDRINUSE" ? resolve({ taken: readInstance() }) : reject(e)));
    server.listen(pipePath(name), () => {
      server.on("error", () => {});
      server.unref(); // a forgotten release never keeps the process alive; the OS frees the pipe at exit
      try {
        store.writeAtomic("instance.json", `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
      } catch (e) {
        server.close(() => reject(e));
        return;
      }
      resolve({ server });
    });
  });
}

/** Frees the pipe. A null server is fine. instance.json stays (the pipe is the lock, the file only a name tag). */
export function releaseInstance(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
}
