import type { Env, Hono } from "hono";
import { serveWebFile, webRootDir } from "../../server/src/web-static.ts";

/**
 * Serve the web app from the control plane's own address, for a deployment that has one server and
 * no separate website: unknown paths (`/join/<token>`, …) are routes of the app. Only the Node
 * server does this; on Cloudflare the website is its own site.
 */
export function mountWeb<E extends Env>(app: Hono<E>, webDir?: string): void {
  const webRoot = webRootDir(webDir);
  if (!webRoot) return;
  app.get("/", (c) => serveWebFile(c, webRoot, "index.html"));
  app.get("/*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/v1" || pathname.startsWith("/v1/")) return c.notFound();
    return serveWebFile(c, webRoot, decodeURIComponent(pathname));
  });
}
