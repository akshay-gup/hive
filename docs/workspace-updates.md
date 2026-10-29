# Updating workspaces in place

## Status

- **Step 1, built:** `/api/health` reports `version` and `features`; the app hides Dismiss and Clear
  all on a workspace that does not list `notifications-dismiss` (`apps/mobile/src/server-features.ts`).
  The image is built with `HIVE_VERSION=<tag>` and carries `/app/VERSION`.
- **Step 2, built, deployed and tested on a real machine:** `apps/workspace/vm/hive-update` with its service,
  timer and path units, and `crane` baked in by `bake.sh`. `tests/workspace-updater.test.ts` runs it on
  folders (update, no-op, rollback, digest mismatch, malformed input, asking the control plane, busy,
  force, request file). It was also run once with the real `crane` against
  `ghcr.io/akshay-gup/hive-workspace:sha-e43cc73` into a scratch folder: about 16 seconds.
  The 2026-10-29 rebake and fresh-Droplet boot checked the real `bake.sh` stages, systemd units and kernel audit support; see [Verification](VERIFICATION.md).
- **Step 3, built, tested and deployed:** `apps/control/src/releases.ts` and routes in `app.ts`.
  A machine asks `GET /v1/release/<workspaceId>` (public, rate limited, answers a public image's tag and
  digest or `{}`); first boot writes `/etc/hive/updater.json` with that address (`cloudConfig`). Publishing
  is `PUT /internal/release` with `Authorization: Bearer $CONTROL_RELEASE_TOKEN`; `PUT /internal/release/paused`
  `{paused}` holds everyone still; `PUT` and `DELETE /internal/release/workspaces/<id>` give a workspace a
  build of its own (a pin ignores the pause and the default); `GET /internal/release` shows both. The image
  workflow does the `PUT` on every push to main when the repository secret `HIVE_RELEASE_TOKEN` is set.
  So a push to main reaches every workspace that has the updater, about twenty minutes later at most.
  To switch it on: set the Worker secret `CONTROL_RELEASE_TOKEN` and the same value as the repository
  secret `HIVE_RELEASE_TOKEN`; bake a snapshot that includes the updater and set `DO_IMAGE` to it.
- **Step 4, not built** ("update now" through the tunnel). Until then a machine updates on its timer.
- **No idle probe yet.** The updater runs `/etc/hive/idle-check` if it exists (exit 0 = idle), and
  there is none, so today it does not wait for the agent. The workspace server has no way to say "idle"
  that the machine could trust: requests through the tunnel arrive from 127.0.0.1, so a loopback-only
  route would be open to the world. It needs a route guarded by a secret the updater can read.

- **Runs survive a restart (built, tested):** a task cut off by an update, a crash or a reboot is
  picked up again by the worker (`apps/server/src/engine/worker.ts`) and goes back into the same
  OpenCode session (`apps/server/src/opencode/tasks.ts`), told to check before repeating any step with
  an outside effect. If that session is gone it starts a new one that says it was interrupted. A run
  that does nothing for 20 minutes is stopped and started again (and let go of after 60 more seconds
  if it will not stop). A task cut off by a crash or a stall three times in a row is marked failed and
  the people on it are told; a stop for an update never counts against it. A chat response cut off by
  the workspace restarting is retried by the app itself, twice at most, once the workspace answers
  (`apps/mobile/src/chat.tsx`). This is why the updater needs no idle check.

## Changing a workspace's settings after it was made

A workspace's settings (its model, the key it reaches the gateway with, the shared environment) are
written to `/etc/hive/workspace.json` once, at first boot. That file is only what the workspace was
**made with**. The control plane owns what they are now, and the workspace asks for them itself
(`apps/workspace/src/remote-settings.ts`), not the shell updater:

- At start, as root and before it gives that up, the workspace asks `GET /v1/release/<id>/config`
  (the address is `wantedUrl` in `/etc/hive/updater.json` plus `/config`) with **its own gateway key**
  as the bearer token (the document can contain that key, so nobody else may read it). It puts the
  answer over what it was made with, and runs on that. `null` takes a setting away, back to nothing;
  taking an override away puts the setting back to what it was made with. The identity and layout
  settings (`WORKSPACE_ID`, `CONTROL_PLANE_PUBLIC_KEY`, `WORKSPACE_MODE`, `HOST`, `PORT`, `DATA_DIR`,
  `VOLUME_DIR`, `WORKSPACE_UID`, `WORKSPACE_GID`, `WORKSPACE_HOME`) are never changed, by the control
  plane or by the workspace.
- Every five minutes after that it asks again; when the revision (`rev`, a short hash of the document)
  is not the one it runs on, it stops and the service manager starts it again, which takes them.
- If the control plane cannot be reached, it starts on the last settings that kept it up
  (`/etc/hive/settings.good.json`), or as it was made. A revision it started on but did not stay up on
  for 45 seconds (it writes `.settings-stayed-up` on its volume once it has) is marked failed
  (`/var/lib/hive/settings.failed`) and not taken again until the control plane says something else, so
  a bad value cannot keep a workspace from starting. The result is `last-config.json` and shows in
  `/api/health` under `update.config`.
- Three layers, later winning: what the control plane works out for the workspace (the gateway's
  model and key), `PUT /internal/release/config` `{env: {NAME: "value" | null}}` for everyone, and
  `PUT /internal/release/config/workspaces/<id>` for one (`DELETE` clears it; `GET .../config` and
  `.../config/workspaces/<id>` show what is set, the latter without values). Changing
  `GATEWAY_MODEL_CONFIG` on the control plane reaches existing workspaces through the first layer.
  The answer to `GET /v1/release/<id>` also carries `config: {v, rev}` for anyone watching.
- **Future changes.** The document is versioned (`v`). A workspace that meets a version it does not
  know leaves its settings alone and says so in `update.config`; the code that reads settings is part of
  the build, so a build that understands a new kind of change is how the workspaces learn it. What is
  not a setting at all goes in `machine/hive-ensure`, which runs from the new build on every update.
- **Idle.** The server keeps the number of runs going in `<DATA_DIR>/runs-live` (a run waiting for an
  answer or an approval counts). Before it restarts for new settings the workspace waits for none, and
  `hive-update` waits for the same before putting a build on (or for an `/etc/hive/idle-check` command
  if an operator put one there; `--force` skips it). Both give up waiting after half an hour, so a count
  left behind by a server that went down badly cannot hold changes back for ever. A restart that does
  land on a run is resumed by the server (above).

## Design

A workspace is a Droplet made from a snapshot. Nothing changes on a Droplet after it is made
(`docs/hosted.md`, "What is not built"), so a server-side fix reaches only workspaces created
after a new snapshot. This is the plan to close that, and to stop the website from offering
what an old workspace cannot do.

## What the code already gives us

- **Code and data are apart.** The program is a plain folder, `/app`, copied out of the container
  image by `apps/workspace/vm/bake.sh`, with `node` and `opencode` beside it in `/usr/local/bin`.
  The data is in `/data` and `/home/hive`, which an update does not touch. The secrets the
  workspace makes for itself are kept in `/data` and are never remade (`supervisor.ts`).
- **No schema to migrate.** Everything is one table of JSON records (`CREATE TABLE IF NOT EXISTS
  records`, `apps/server/src/db.ts`). A change to what a record holds is handled in code, and has
  to stay readable by the version before it. That is the rule for the first release that changes
  a record's shape.
- **A build is already published.** `.github/workflows/workspace-image.yml` pushes
  `ghcr.io/<owner>/hive-workspace:sha-<7>` on every push to main, and the package is public.
- **The control plane already reaches a workspace** through its tunnel (`POST /api/auth/managed`
  with a token it signs), and the machine can reach out (the firewall's output rule accepts
  root's traffic; inbound is closed by the cloud firewall).
- **`/api/health` says nothing about the version** (`apps/server/src/app.ts`). That is the gap
  the website needs filled first.

## Parts, in the order to build them

### 1. The workspace says what it is (small, do first)

`/api/health` gains `version` (the image tag, written into the image at build time as
`/app/VERSION`) and `features`, a short list of names such as `notifications-dismiss`. The app
reads it once per workspace and hides a control whose feature is missing. An old workspace then
shows no Dismiss button instead of one that fails. A workspace that reports nothing is treated as
the oldest version.

### 2. The updater on the machine

A root-owned systemd service, `hive-updater.service`, started by a timer (every 15 minutes) and
by a path unit that watches `/var/lib/hive/update-request`. It:

1. asks the control plane for this workspace's wanted version (one HTTPS call, authenticated with
   the machine's tunnel or workspace credential),
2. does nothing if that is the version in `/app/VERSION`,
3. waits until the workspace is idle (no agent run in progress, asked of the server on
   127.0.0.1), unless the request says `force`,
4. fetches that image's `/app`, `node` and `opencode` into `/app.next` (the image is pulled with
   `crane export` or `skopeo`, no Docker daemon kept running), and checks the image digest the
   control plane gave it,
5. stops `hive-workspace`, renames `/app` to `/app.prev` and `/app.next` to `/app`, starts it,
6. polls `/api/health` for 60 seconds; if it does not answer with the new version, puts
   `/app.prev` back, starts it and reports `failed`.

It runs as root and not as the workspace user, whose agent may use sudo but must not be the one
deciding what code runs. It reports `{version, state, at}` to the control plane after each step.

### 3. The control plane decides

- A column on each workspace: `wanted_version` (an image tag and its digest). A setting
  `default_version` is what a new workspace and any workspace without its own value gets.
- `GET /v1/workspaces/:id/wanted-version`, which the updater calls. It returns the tag, the
  digest and `force`.
- `PUT /v1/admin/workspaces/:id/version` and `PUT /v1/admin/default-version`, for the operator
  only. Rolling out is: set your own workspace, look at it, set the default.
- Rolling back is setting the earlier tag. It takes the same path.
- The reported `{version, state}` is stored and shown on the operator's page, so who is behind
  is visible.

### 4. "Update now"

The operator's page calls the workspace through the tunnel with a control-plane-signed request;
the workspace server writes `/var/lib/hive/update-request` and nothing more. The path unit starts
the updater at once. The server never has root and never holds a version to fetch; it only wakes
the updater.

## Order and size

| Step | What | Rough size |
|---|---|---|
| 1 | `version` and `features` in `/api/health`; the app hides missing features | small |
| 2 | Updater script, units, rollback, in `apps/workspace/vm`, and baked into the snapshot | medium |
| 3 | `wanted_version`, the two admin routes, the report, in `apps/control` | medium |
| 4 | "Update now": a signed call and the request file | small |

The first workspace to get step 2 has to be made from a new snapshot, because nothing exists on
the old ones to install it. That is the last time a snapshot is needed for a program change.

## Unsolved, on purpose

- **A restart ends an agent run in progress.** The default waits for idle; `force` does not.
- **`node`, `opencode` and Ubuntu are not versioned by this** beyond what the image holds.
  Ubuntu's security updates already install themselves; a new kernel needs a restart.
- **Who may set a version.** The admin routes need an operator identity the control plane does
  not have yet (today it knows accounts, not operators).
- **A bad release is only caught on one workspace at a time** if the operator rolls out one
  workspace first. There is no automatic canary.
