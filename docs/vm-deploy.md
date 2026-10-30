# VM deploy

This is one Hive for one team on one box. To run Hive as a service that starts a workspace for each team, see [Hosted workspaces](hosted.md).

One box, one process. The API serves the web UI itself (same origin), runs
the task worker in-process, and keeps the database plus channel storage on
local disk. Open the VM's URL in a browser; mobile clients point at the same
URL later.

## Build

```sh
pnpm install
pnpm build:server   # -> dist/
pnpm build:web      # -> apps/mobile/dist/web (served by the API)
```

## Install on the VM

Unit files and a Caddyfile live in `deploy/`. OpenCode 1.18.x on the VM matches
the pinned `@opencode-ai/sdk` 1.18.33 (the API asserts the major version on boot).

```sh
# 1. Service user and directories
sudo useradd -r -m -s /usr/sbin/nologin hive
sudo mkdir -p /opt/hive /etc/hive
sudo chown hive:hive /opt/hive /etc/hive

# 2. App code (as the hive user)
sudo -u hive git clone <repo> /opt/hive   # or copy the built tree
cd /opt/hive
sudo -u hive pnpm install
sudo -u hive pnpm build:server
sudo -u hive pnpm build:web

# 3. opencode binary (1.18.x) — install once, usable by the service user
sudo curl -fsSL https://opencode.ai/install | sh
# The installer drops the binary in ~/.opencode/bin; copy it system-wide:
sudo cp ~/.opencode/bin/opencode /usr/local/bin/opencode
opencode --version   # want 1.18.x

# 4. Env file — internal secrets are generated on the spot, not asked for
sudo mkdir -p /opt/hive/bin
sudo cp deploy/setup-env.sh /opt/hive/bin/ && sudo chmod +x /opt/hive/bin/setup-env.sh
sudo /opt/hive/bin/setup-env.sh   # writes /etc/hive/hive.env with the generated secrets
# (sets root:hive / 640 itself; safe to rerun — existing values are kept)
# then edit /etc/hive/hive.env: set MODEL + provider key, PUBLIC_API_URL, and the Google
# OAuth client (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET): people sign in with Google

# 5. Units — opencode first, then the API
sudo cp deploy/hive-opencode.service deploy/hive-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hive-opencode
sleep 3
curl -u opencode:<password> http://127.0.0.1:4096/global/health -o /dev/null -w "%{http_code}\n"  # 200
sudo systemctl enable --now hive-api
sudo journalctl -u hive-api -f   # watch for the opencode version assert passing

# 6. HTTPS — point DNS at the VM, then
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

Updating later: pull/rebuild in `/opt/hive`, then
`sudo systemctl restart hive-api` (leave `hive-opencode` running —
sessions survive API restarts).

## Public URL via Cloudflare Tunnel (free, recommended)

One-time setup (~5 min):

1. Create a free Cloudflare account and add your domain (DNS only — the
   registration stays where it is). Change the nameservers at your registrar
   to the ones Cloudflare gives you.
2. On the VM, install cloudflared:
   `curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null`
   then add the apt repo and `sudo apt install cloudflared` (or download the
   binary to `/usr/local/bin`).
3. `sudo -u hive cloudflared tunnel login` — open the printed URL in your
   browser and authorize. This drops credentials in `~hive/.cloudflared/`.

Per box (each box gets its own stable public hostname):

```sh
sudo -u hive cloudflared tunnel create hive-1
# note the tunnel ID it prints
sudo -u hive cloudflared tunnel route dns hive-1 hive-1.example.com
# cloudflared creates the DNS record for you — no manual DNS
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/hive/cloudflared-credentials.json
# copy deploy/hive-cloudflared.yml to /etc/hive/cloudflared.yml,
# filling in TUNNEL_ID and PUBLIC_HOSTNAME (hive-1.example.com)
sudo cp deploy/hive-cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hive-cloudflared
```

Then set `PUBLIC_API_URL=https://hive-1.example.com` in `/etc/hive/hive.env`
(OAuth callbacks need https) and restart `hive-api`. Keep `HOST=127.0.0.1` —
the tunnel is the only door in.

Throwaway alternative with no account at all: run
`cloudflared tunnel --url http://127.0.0.1:8787`, copy the
`https://<random>.trycloudflare.com` URL it prints, then hand it to the setup
script and restart the API:

```sh
sudo /opt/hive/bin/setup-env.sh /etc/hive/hive.env https://<random>.trycloudflare.com
sudo systemctl restart hive-api
```

(The named-tunnel path above passes the stable hostname the same way:
`setup-env.sh /etc/hive/hive.env https://hive-1.example.com`.)

## Quick launch without public DNS (Tailscale)

For throwaway boxes or many of them, skip DNS and Caddy: put the VM on your
tailnet and reach the API over the private mesh.

```sh
# On the VM (after the install steps above, skipping the Caddy step)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In `/etc/hive/hive.env` set:

```
HOST=0.0.0.0
PUBLIC_API_URL=http://<tailscale-hostname>:8787
```

Then open `http://<tailscale-hostname>:8787` from any device on the tailnet
(Tailscale app on iOS). Notes:

- Sign-in is Google OAuth only; Tailscale only replaces
  DNS/TLS here, and its WireGuard mesh is encrypted.
- Google OAuth callbacks need a public https URL — connect Google later via
  the Caddy path above.

## Run (local dev)

```sh
pnpm start
```

Environment:

| Variable | Required | Notes |
|---|---|---|
| `WORKSPACE_MODE` | yes | `live` (sample mode only binds loopback) |
| `HOST` | no | `127.0.0.1` default; keep loopback behind a reverse proxy |
| `PORT` | no | `8787` default |
| `DATA_DIR` | no | `/opt/hive/data` (set by `setup-env.sh`); the database, files, and the channel workspaces (`owners/shared/channels/<id>/`, thread bindings in `threads/*.json`) live here |
| `WEB_DIR` | no | overrides the served web UI dir (default `apps/mobile/dist/web`); unset/absent = headless API |
| `TOKEN_ENCRYPTION_KEY` | yes | generated by `setup-env.sh`; 32 random bytes, base64-encoded |
| `MODEL` | yes | e.g. `openai/gpt-5`; plus the matching provider key (`OPENAI_API_KEY`, …) |
| `OPENCODE_SERVER_URL` | no | `http://127.0.0.1:4096` default; the systemd-managed `opencode serve` (never spawned by the API) |
| `OPENCODE_SERVER_PASSWORD` | no | generated by `setup-env.sh`; Basic-auth password for `opencode serve` |
| `PUBLIC_API_URL` | yes | the public https URL; used for OAuth callbacks and CORS |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | the Google OAuth web client, with `${PUBLIC_API_URL}/api/google/callback` as a redirect URI. It is how people sign in (there is no shared sign-in key) and how Gmail and Calendar connect. Hive has no member list or roles yet, so its consent screen is the only gate on who joins: keep it to your team |
| `JEV_MODE` | no | choice cards: `off` (default), `sample`, or `live` (needs `TYPESAFE_API_KEY`; see [what live mode sends](demos/jev-generative-ui.md#what-live-mode-sends-to-typesafe)) |

## OpenCode agent layer

Run `opencode serve` as a systemd unit on the VM (it owns its own auth and
model configuration). On boot the API health-checks it and asserts the major
version matches the bundled `@opencode-ai/sdk`, failing loud if unreachable —
it never spawns the server itself. Each channel thread gets one OpenCode
session (bound via `opencodeSessionId` in its thread file, created before the
first prompt); one global SSE stream fans events out per thread, and the
runs the chat service starts are translated between its messages and OpenCode
here. The agent runs when a message names it (`@hive`) in a channel, and for
every message in a person's own chat; it receives the conversation so far plus
any attached files.

Generate the secrets:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # encryption key
```

## HTTPS (Caddy)

```caddy
hive.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Caddy fetches the certificate automatically. Keep `HOST=127.0.0.1` so the API
is only reachable through the proxy.

## Notes

- Channel workspace directories are created on first use under
  `DATA_DIR/owners/shared/channels/<channelId>/` (a person's orchestrator gets
  `DATA_DIR/owners/<person>/channels/orchestrator/`). They are plain directories on
  the box and are the working directories of the channel's OpenCode sessions, so
  back them up with the rest of `DATA_DIR`.
- The browser worker (`apps/worker`) is a separate optional process; the app
  runs without it, minus page reads, screenshots, and takeover.
