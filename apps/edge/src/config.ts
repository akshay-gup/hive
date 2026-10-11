type Env = Record<string, string | undefined>;

export interface EdgeConfig {
  /** The domain workspaces are under: a workspace is reached at `<id>.<domain>`. */
  domain: string;
  /** The control plane, which says where a workspace is. */
  controlUrl: string;
  /** What the control plane wants to see before it answers (CONTROL_EDGE_TOKEN there). */
  token: string;
  /** The certificate for `*.<domain>` and its key, as PEM files; `null` serves plain http, behind something that has TLS. */
  tls: { certFile: string; keyFile: string } | null;
  host: string;
  httpsPort: number;
  /** The port that sends people to https; null for none. */
  httpPort: number | null;
  /** The address ranges (IPv4, CIDR) a workspace may be at; the edge connects nowhere else. */
  upstreamAllow: string[];
  /** How long what the control plane said is believed, and how long that a name is unknown or stopped is. */
  cacheMs: number;
  negativeMs: number;
  /** How long a workspace gets to answer a request with its headers, and to accept a connection. */
  headersTimeoutMs: number;
  connectTimeoutMs: number;
  /** How often the certificate files are looked at for a renewal. */
  reloadMs: number;
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

/** The edge's settings from the environment (EDGE_*), or an error naming what is missing. */
export function readEdgeConfig(env: Env = process.env): EdgeConfig {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`The edge needs ${name}`);
    return value;
  };
  const port = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0 || value > 65535)
      throw new Error(`${name} must be a port number`);
    return value;
  };
  const whole = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number`);
    return value;
  };
  const domain = need("EDGE_DOMAIN").toLowerCase().replace(/^\*\./, "").replace(/\.+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    throw new Error("EDGE_DOMAIN must be a domain name such as ws.example.com");
  const controlUrl = need("EDGE_CONTROL_URL").replace(/\/+$/, "");
  try {
    const parsed = new URL(controlUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("EDGE_CONTROL_URL must be an http or https address");
  }
  const token = need("EDGE_TOKEN");
  if (token.length < 32) throw new Error("EDGE_TOKEN must be at least 32 characters");
  const certFile = env.EDGE_TLS_CERT?.trim();
  const keyFile = env.EDGE_TLS_KEY?.trim();
  const plain = env.EDGE_TLS?.trim().toLowerCase() === "off";
  if (!plain && (!certFile || !keyFile))
    throw new Error(
      "The edge needs EDGE_TLS_CERT and EDGE_TLS_KEY, or EDGE_TLS=off behind something that ends TLS",
    );
  const allow = (env.EDGE_UPSTREAM_ALLOW ?? PRIVATE_RANGES.join(","))
    .split(",")
    .map((range) => range.trim())
    .filter(Boolean);
  for (const range of allow) parseCidr(range);
  return {
    domain,
    controlUrl,
    token,
    tls: plain ? null : { certFile: certFile as string, keyFile: keyFile as string },
    host: env.EDGE_HOST?.trim() || "0.0.0.0",
    httpsPort: port("EDGE_HTTPS_PORT", plain ? 8080 : 443),
    httpPort:
      plain || env.EDGE_HTTP_PORT?.trim().toLowerCase() === "off"
        ? null
        : port("EDGE_HTTP_PORT", 80),
    upstreamAllow: allow,
    cacheMs: whole("EDGE_CACHE_SECONDS", 60) * 1000,
    negativeMs: whole("EDGE_NEGATIVE_SECONDS", 3) * 1000,
    headersTimeoutMs: whole("EDGE_HEADERS_TIMEOUT_SECONDS", 120) * 1000,
    connectTimeoutMs: whole("EDGE_CONNECT_TIMEOUT_SECONDS", 5) * 1000,
    reloadMs: whole("EDGE_RELOAD_SECONDS", 300) * 1000,
  };
}

/** An IPv4 range as the address and the mask it comes to, or an error naming it. */
export function parseCidr(range: string): { base: number; mask: number } {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(range);
  const octets = match?.slice(1, 5).map(Number) ?? [];
  const bits = Number(match?.[5]);
  if (!match || octets.some((octet) => octet > 255) || bits > 32)
    throw new Error(
      `EDGE_UPSTREAM_ALLOW has ${JSON.stringify(range)}, which is not an IPv4 range like 10.0.0.0/8`,
    );
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const address = octets.reduce((total, octet) => total * 256 + octet, 0) >>> 0;
  return { base: (address & mask) >>> 0, mask };
}

/** Whether an IPv4 address is inside any of the ranges. Names, IPv6 and anything else are not. */
export function allowedAddress(host: string, ranges: string[]): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const address = octets.reduce((total, octet) => total * 256 + octet, 0) >>> 0;
  return ranges.some((range) => {
    const { base, mask } = parseCidr(range);
    return (address & mask) >>> 0 === base;
  });
}
