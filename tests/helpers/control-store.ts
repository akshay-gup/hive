import { D1Store } from "../../apps/control/src/d1-store.ts";
import type { ControlStore } from "../../apps/control/src/store.ts";
import { createStore } from "../../apps/server/src/db.ts";
import { memoryD1 } from "./d1-shim.ts";

export type ControlTestStore = ControlStore & { close(): Promise<void> };

/**
 * The store a control plane test runs on: the Postgres one (embedded, so no server is needed) as
 * the Node server uses, or, with CONTROL_TEST_STORE=d1, the D1 one on Node's SQLite as Cloudflare
 * runs it. The same tests must pass on both.
 */
export async function createControlStore(): Promise<ControlTestStore> {
  if (process.env.CONTROL_TEST_STORE === "d1")
    return Object.assign(new D1Store(memoryD1()), { close: async () => {} });
  return createStore();
}
