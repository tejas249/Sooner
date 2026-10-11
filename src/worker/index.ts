import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), process.env, {
  io: { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
  signals: process,
  forceExit: (code) => process.exit(code),
});
