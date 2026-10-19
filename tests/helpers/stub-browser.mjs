// Stands in for the browser worker when a test runs the workspace supervisor: it answers "pong" on
// its port, writes down each time it starts and stops, and can leave by itself like the real one.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const mark = (event) => appendFileSync(process.env.MARKERS, `browser ${event} ${Date.now()}\n`);
createServer((_request, response) => response.end("pong")).listen(
  Number(process.env.STUB_BROWSER_PORT),
  "127.0.0.1",
  () => mark("started"),
);
if (process.env.STUB_EXIT_AFTER_MS)
  setTimeout(() => process.exit(0), Number(process.env.STUB_EXIT_AFTER_MS));
process.on("SIGTERM", () => {
  mark("terminated");
  process.exit(0);
});
