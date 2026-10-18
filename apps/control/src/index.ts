import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createStore } from "../../server/src/db.ts";
import { createControlApp } from "./app.ts";
import { readControlConfig } from "./config.ts";
import { gatewayFromEnv } from "./gateway.ts";
import { GoogleSignIn } from "./google.ts";
import { provisionerFromEnv } from "./provisioners.ts";
import { loadSigningKeys } from "./signing.ts";
import { mountWeb } from "./web.ts";

const config = readControlConfig();
const db = await createStore({
  dataDir: join(config.dataDir, "postgres"),
  databaseUrl: config.databaseUrl,
});
const keys = await loadSigningKeys(config.dataDir);
const provisioner = provisionerFromEnv();
// A live control plane always has Google's client (the config insists); a sample one uses it if given.
const google =
  config.googleClientId && config.googleClientSecret
    ? new GoogleSignIn(db, {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: config.googleRedirectUri,
      })
    : undefined;
const { app, accounts, workspaces } = createControlApp(db, config, {
  provisioner,
  keys,
  google,
  gateway: gatewayFromEnv(),
});
mountWeb(app, config.webDir);

// Pick up workspaces a restart interrupted, and again now and then for removals that did not finish;
// the same rounds sweep away sign-ins that have expired.
const upkeep = async () => {
  await workspaces.resume();
  await accounts
    .sweep()
    .catch((error) => console.error(`[Hive control] could not sweep expired sign-ins: ${error}`));
};
await upkeep();
const sweep = setInterval(() => void upkeep(), 5 * 60 * 1000);
sweep.unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(
    `Hive control ${config.mode} at ${config.publicUrl} (provisioner: ${provisioner.name})`,
  ),
);
const shutdown = () => {
  clearInterval(sweep);
  server.close(() => {
    void (provisioner.close?.() ?? Promise.resolve())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
