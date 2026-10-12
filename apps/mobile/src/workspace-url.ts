/**
 * Turn what someone types into a workspace address: an origin like `https://team.example.com`.
 * Written without `URL`, whose parts React Native only partly provides.
 */
export type WorkspaceAddress = { url: string } | { error: string };

const address =
  /^(?:(https?):\/\/)?(?:([^@/?#\s]*)@)?(\[[0-9a-f:.]+\]|[^\s/?#:@[\]]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i;
const hostname =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Hosts on the device's own network, which may be reached over http (and are what a dev server is). */
export function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host === "[::1]") return true;
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function normalizeWorkspaceUrl(input: string): WorkspaceAddress {
  const text = input.trim();
  if (!text) return { error: "Enter your workspace address." };
  const match = address.exec(text);
  if (!match) return { error: "That does not look like a web address." };
  const [, explicitScheme, userinfo, rawHost, port] = match;
  if (userinfo !== undefined) return { error: "Leave out the username and password." };
  const host = rawHost.toLowerCase();
  const isIpv6 = host.startsWith("[");
  if (!isIpv6 && !hostname.test(host)) return { error: "That does not look like a web address." };
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    return { error: "That port is not valid." };
  const local = isLocalHost(host);
  const scheme = explicitScheme?.toLowerCase() ?? (local ? "http" : "https");
  if (scheme === "http" && !local) return { error: "Use https:// so your sign-in stays private." };
  const isDefaultPort =
    (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  return { url: `${scheme}://${host}${port && !isDefaultPort ? `:${Number(port)}` : ""}` };
}

/** The name to show for a workspace address. */
export function workspaceLabel(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
