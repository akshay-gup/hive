import { readEdgeConfig } from "./config.ts";
import { startEdge } from "./proxy.ts";

const edge = await startEdge(readEdgeConfig());

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[Hive edge] ${signal}: stopping`);
  void edge.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
