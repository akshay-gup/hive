import { LocalProvisioner, localConfigFromEnv } from "./local.ts";
import type { Provisioner } from "./provisioner.ts";
import { remoteProvisionerFromEnv } from "./provisioners-remote.ts";

/** The provisioner PROVISIONER names: `fly` or `digitalocean` for a deployment, `local` to try the flow on a laptop. */
export function provisionerFromEnv(
  env: Record<string, string | undefined> = process.env,
): Provisioner {
  const remote = remoteProvisionerFromEnv(env);
  if (remote) return remote;
  if (env.PROVISIONER?.trim() === "local") return new LocalProvisioner(localConfigFromEnv(env));
  throw new Error("Set PROVISIONER to fly or digitalocean (a deployment) or local (a laptop)");
}
