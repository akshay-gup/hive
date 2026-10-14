import { DigitalOceanProvisioner, digitalOceanConfigFromEnv } from "./digitalocean.ts";
import { FlyProvisioner, flyConfigFromEnv } from "./fly.ts";
import type { Provisioner } from "./provisioner.ts";

/**
 * The hosted providers PROVISIONER names (`fly` or `digitalocean`), or undefined for anything else.
 * Apart from `provisioners.ts` so that a Worker, which cannot start processes, does not take in the
 * one that does.
 */
export function remoteProvisionerFromEnv(
  env: Record<string, string | undefined>,
): Provisioner | undefined {
  switch (env.PROVISIONER?.trim()) {
    case "fly":
      return new FlyProvisioner(flyConfigFromEnv(env));
    case "digitalocean":
      return new DigitalOceanProvisioner(digitalOceanConfigFromEnv(env));
    default:
      return undefined;
  }
}
