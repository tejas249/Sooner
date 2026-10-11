import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVE_SCRIPT = fileURLToPath(new URL("../../../tools/dev-db/serve.mjs", import.meta.url));

export interface RunningServer {
  /** A superuser URL to the server's default database. */
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Postgres (tools/dev-db) and waits until it accepts connections. The first run installs the
 * database binaries, which can take a minute. The server stops when `stop` is called, or on its own if this process
 * dies, because the child watches its end of the stdin pipe.
 */
export function startEphemeralPostgres(timeoutMs = 180_000): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE_SCRIPT, "--ephemeral", "--database", "postgres"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error(`the test database did not start within ${timeoutMs / 1000} seconds\n${stderr}`));
      child.kill("SIGKILL");
    }, timeoutMs);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const ready = /^READY (\S+)$/m.exec(stdout);
      if (!ready || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: ready[1] as string,
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            const force = setTimeout(() => child.kill("SIGKILL"), 20_000);
            child.once("exit", () => {
              clearTimeout(force);
              done();
            });
            child.kill("SIGTERM");
          }),
      });
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => fail(new Error(`the test database exited with code ${code}\n${stderr}`)));
  });
}
