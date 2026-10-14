import { CloudflareApi, CloudflareError } from "./cloudflare-api.ts";
import { ProvisionError } from "./provisioner.ts";

export interface CloudflareTunnelConfig {
  /** Can edit Cloudflare Tunnels on the account and DNS on the zone. */
  apiToken: string;
  accountId: string;
  /** The zone the workspaces' addresses are in. */
  zoneId: string;
  apiUrl: string;
  /** Put in front of the workspace id to name its tunnel. */
  namePrefix: string;
  /** Where the tunnel's connector, on the workspace's machine, sends what arrives. */
  service: string;
  /** The first pause before trying a refused call again (milliseconds; 500 when unset). */
  retryMs?: number;
}

type Env = Record<string, string | undefined>;

/** The settings from the environment (CLOUDFLARE_*), or an error naming what is missing. */
export function cloudflareTunnelConfigFromEnv(
  env: Env,
  namePrefix: string,
  service: string,
): CloudflareTunnelConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Reaching workspaces through Cloudflare Tunnels needs ${name}`);
    return value;
  };
  return {
    apiToken: need("CLOUDFLARE_API_TOKEN"),
    accountId: need("CLOUDFLARE_ACCOUNT_ID"),
    zoneId: need("CLOUDFLARE_ZONE_ID"),
    apiUrl: (env.CLOUDFLARE_API_URL?.trim() || "https://api.cloudflare.com/client/v4").replace(
      /\/+$/,
      "",
    ),
    namePrefix,
    service,
  };
}

interface Tunnel {
  id: string;
  name: string;
  deleted_at?: string | null;
  created_at?: string;
}
interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

/** What a tunnel's DNS name points at. Only a record that points at one of these is ours to change. */
const TUNNEL_DOMAIN = "cfargotunnel.com";
const pointsAtATunnel = (record: DnsRecord) =>
  record.type === "CNAME" && record.content.toLowerCase().endsWith(`.${TUNNEL_DOMAIN}`);

/**
 * A Cloudflare Tunnel for each workspace, which is how people reach a workspace without anything
 * on its machine listening for them: the machine runs `cloudflared` with the tunnel's token, which
 * connects out to Cloudflare, and Cloudflare sends the workspace's address down that connection.
 * Cloudflare holds the certificate, so no key is on the machine either.
 *
 * Each step can be repeated: a tunnel, its route and its address that exist are used as they are.
 */
export class CloudflareTunnels {
  private readonly api: CloudflareApi;

  constructor(private readonly config: CloudflareTunnelConfig) {
    this.api = new CloudflareApi({
      token: config.apiToken,
      apiUrl: config.apiUrl,
      retryMs: config.retryMs,
    });
  }

  /** `hive-ws-<id>`: what finds a workspace's tunnel again, and nobody else's. */
  tunnelName(workspaceId: string): string {
    return `${this.config.namePrefix}-ws-${workspaceId}`.toLowerCase();
  }

  /**
   * Make the workspace's tunnel, send `hostname` down it to the workspace's port, and give back the
   * token its machine runs with. The token lets whoever has it be the workspace's end of the
   * tunnel, so it goes only to the machine's settings.
   */
  async ensure(workspaceId: string, hostname: string): Promise<{ token: string }> {
    return this.guarded(async () => {
      const tunnel = await this.tunnelFor(workspaceId);
      await this.api.call("PUT", `${this.tunnelPath(tunnel.id)}/configurations`, {
        config: {
          ingress: [{ hostname, service: this.config.service }, { service: "http_status:404" }],
        },
      });
      await this.route(workspaceId, hostname, tunnel.id);
      const token = await this.api.call<string>("GET", `${this.tunnelPath(tunnel.id)}/token`);
      if (typeof token !== "string" || !token)
        throw new ProvisionError("Cloudflare gave no token for the tunnel");
      return { token };
    });
  }

  /** Take the workspace's address and tunnel away. Nothing there is not an error. */
  async remove(workspaceId: string, hostname: string): Promise<void> {
    await this.guarded(async () => {
      // The address first, so nothing is sent down a tunnel that is going.
      for (const record of await this.records(hostname))
        if (pointsAtATunnel(record))
          await this.api.call(
            "DELETE",
            `/zones/${this.config.zoneId}/dns_records/${record.id}`,
            undefined,
            [404],
          );
      for (const tunnel of await this.tunnels(workspaceId)) {
        // A tunnel with a connection cannot be deleted, and a machine just destroyed may not have
        // been noticed to be gone yet: end its connections, then the tunnel.
        await this.api.call(
          "DELETE",
          `${this.tunnelPath(tunnel.id)}/connections`,
          undefined,
          [404],
        );
        await this.api.call("DELETE", this.tunnelPath(tunnel.id), undefined, [404]);
      }
    });
  }

  // The steps of `ensure`.

  /** The workspace's tunnel, made if there is none; the oldest if a repeated call made two. */
  private async tunnelFor(workspaceId: string): Promise<Tunnel> {
    const found = (await this.tunnels(workspaceId))[0];
    if (found) return found;
    try {
      const made = await this.api.call<Tunnel>(
        "POST",
        `/accounts/${this.config.accountId}/cfd_tunnel`,
        {
          name: this.tunnelName(workspaceId),
          // Its routes are kept by Cloudflare, so the machine needs only its token.
          config_src: "cloudflare",
        },
      );
      if (made?.id) return made;
    } catch (error) {
      // Another call made it a moment ago.
      const raced = (await this.tunnels(workspaceId))[0];
      if (raced) return raced;
      throw error;
    }
    throw new ProvisionError("Cloudflare made a tunnel but did not say which");
  }

  /** The address points at the tunnel. Another kind of record already there is not ours to replace. */
  private async route(workspaceId: string, hostname: string, tunnelId: string) {
    const content = `${tunnelId}.${TUNNEL_DOMAIN}`;
    const existing = await this.records(hostname);
    const other = existing.find((record) => !pointsAtATunnel(record));
    if (other)
      throw new ProvisionError(
        `Cloudflare: ${hostname} already has a ${other.type} record that is not a tunnel's; ` +
          `workspace addresses must be names nothing else uses`,
      );
    const [ours, ...extra] = existing;
    for (const record of extra)
      await this.api.call(
        "DELETE",
        `/zones/${this.config.zoneId}/dns_records/${record.id}`,
        undefined,
        [404],
      );
    const wanted = {
      type: "CNAME",
      name: hostname,
      content,
      proxied: true,
      ttl: 1,
      comment: `Hive workspace ${workspaceId}`,
    };
    if (!ours) {
      await this.api.call("POST", `/zones/${this.config.zoneId}/dns_records`, wanted);
    } else if (ours.content.toLowerCase() !== content || ours.proxied !== true) {
      // Left from a tunnel this workspace had before: point it at this one.
      await this.api.call("PATCH", `/zones/${this.config.zoneId}/dns_records/${ours.id}`, {
        content,
        proxied: true,
      });
    }
  }

  // Cloudflare's lists.

  private tunnelPath(tunnelId: string) {
    return `/accounts/${this.config.accountId}/cfd_tunnel/${tunnelId}`;
  }

  /** The workspace's tunnels that exist, oldest first. */
  private async tunnels(workspaceId: string): Promise<Tunnel[]> {
    const name = this.tunnelName(workspaceId);
    const found = await this.api.all<Tunnel>(
      `/accounts/${this.config.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    return found
      .filter((tunnel) => tunnel.name === name && !tunnel.deleted_at)
      .sort(
        (a, b) =>
          (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
      );
  }

  private records(hostname: string): Promise<DnsRecord[]> {
    return this.api.all<DnsRecord>(
      `/zones/${this.config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    );
  }

  /** Cloudflare's own errors as the provisioner's, so a failure names who refused. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CloudflareError)
        throw new ProvisionError(`Cloudflare: ${error.message}`);
      throw error;
    }
  }
}
