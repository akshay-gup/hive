# Hive roadmap (`collab` branch)

Direction: a self-contained, agent-native team chat. One box, one process serving
API + web UI, OpenCode as the agent backend, threads as durable agent sessions, and
one workspace shared by the team, so what the agent is given once is there for everyone.

## Shipped

- **Self-contained VM deployment** — the Hono API serves the Expo web export
  same-origin (SPA fallback, `WEB_DIR` override); channel and thread storage is on
  local disk (`DATA_DIR/owners/<owner>/channels/<id>/`, which are also the OpenCode
  working directories). See `docs/vm-deploy.md`.
- **OpenCode agent** — one `opencode serve`
  process (a systemd unit on the VM; the API connects, healthchecks, and
  version-asserts, never spawns it); per-channel scoping via directory header;
  a single global SSE stream with per-thread filtering and serialized queues;
  busy/idle derived from status events only; the run translation the chat
  service's runs go through;
  thread→session bindings persisted before the first prompt; single `MODEL` env.
  Boot fails without OpenCode.
- **Permissions** — default `ask`; `permission.asked` tracked per thread and
  surfaced as approve/deny in the thread UI; per-channel/per-thread rules stored
  under `DATA_DIR` and applied as session permission overrides (directory-level
  allows stay in server config); pending requests rejected on teardown.
- **Shared workspace** — everything belongs to the team except each person's
  orchestrator chat: channels, threads and their messages, tasks and the work the
  orchestrator creates, reviews, files, drafts, browser sessions, the agent's memory
  and settings, and the one Google connection. `SHARED_KINDS` in
  `apps/server/src/db.ts` lists the record kinds, and a test fails if a kind is added
  without placing it. What people can open follows their role in a hosted workspace; otherwise everyone who signs in has the same access (see Roles below).
- **Choice cards** — `present_choices` (Jev, off unless `JEV_MODE` is set) is one of the
  Hive tools OpenCode is offered. Cards are kept with the conversation they were asked
  in: a team thread's belong to the team, an orchestrator chat's to its owner.
- **Task worker on OpenCode** — delegated tasks run as OpenCode sessions in
  auto-mode (default-ask would stall unattended runs); `TASK_COMPLETE:` /
  `TASK_BLOCKED:` markers parsed from final text; background permission requests
  surface in the originating thread.
- **Review before done** — agent work (the `TASK_COMPLETE:` marker or the
  `finish_task` tool) goes to an `in_review` state; only a person
  marks it done (`POST /tasks/:id/accept`) or sends it back with a note. The
  agent's `update_task` cannot set `succeeded`.
- **Task notes and files** — append-only notes and attached files (PDF, images,
  text) on every task, read by every run; notes added to a running OpenCode task
  are sent into its session by a watcher that polls the task row, so it works
  across the API/worker process split.
- **Channel files** — a Files browser per channel over its workspace (recent
  changes and folders, previews by kind, upload), served by 15-minute links that
  keep their scope in the path (a web page's covers its folder) with a sandbox
  policy and `Range` support; paths never leave the workspace (links are not
  followed). The agent's `send_file` shares a file as a card and `request_upload`
  asks for files with an upload button and modal (the call returns at once; the
  upload is recorded against the request and a message back names each file).
- **Hosted workspaces** — a control plane (`apps/control`) with accounts, Google
  sign-in, workspaces, members (owner, admin, member) and invitations; a provisioner
  that starts each workspace on Fly Machines (an app, a private network, an encrypted
  volume and a machine of its own), on a Droplet of its own on DigitalOcean (the whole
  disk the workspace's, reached through an edge, `apps/edge`, that serves TLS), or as a
  local process; workspace tokens that sign a
  person in to a workspace without the workspace knowing anything else about them; a
  workspace image (`apps/workspace`) that runs the server and OpenCode; and the app's
  own screens for signing in, making and opening workspaces, and inviting people. See
  `docs/hosted.md`.
- **Channel/thread engine** — channels as worker scopes, threads as sessions,
  user-driven rename (display metadata only; ID-based paths stable), new channels
  start with zero threads.

## Next

- [ ] Channel files: delete and rename from the browser; drag and drop into the
      upload modal; Markdown that links to images beside it (the previewer does
      not resolve relative links yet); a player for video and audio on iOS and
      Android (they open in the system player); checking `send_file` and
      `request_upload` against a real `opencode serve` agent.

- [ ] Verifying live notes against a real `opencode serve` — the stand-in
      session in the tests checks our side of the conversation, not OpenCode's
      queueing.

- [ ] Live VM verification: end-to-end task loop with real inference (needs
      provider keys on the VM); `opencode serve` systemd unit definition.
- [ ] Shared-computer arbitration between channel workers on the one box
      (today workers share the filesystem with no scoping).
- [ ] Orchestrator queue and new-tab routing for delegated tasks; delegated
      status (queued/working/done) visible in the originating channel.
- [ ] **Hosted, still to build.** Billing and plans that are enforced. A model the platform
      pays for without putting its key in every workspace (a gateway the workspaces call).
      A workspace that stays awake while its agent is working: Fly stops a machine it sees
      no requests for, which can cut a delegated task short on a plan that stops when idle.
      Gmail and Calendar through the control plane, since an OAuth client cannot list a
      redirect for every workspace. Email for invitations (the control plane prints them).
      Rolling a new image out to workspaces that are running. On DigitalOcean, idle
      workspaces that cost nothing (a Droplet costs the same off as on), and a copy of a
      workspace's disk that is not on its host. Cleaning up expired sessions,
      login codes and sign-in states in the control plane. The agent as a user of its own
      inside a workspace, so it cannot read the server's secrets. Returning from sign-in on
      a phone by a link the app owns rather than a custom scheme, and binding the code to
      the app that asked. Trying all of it on a real Fly or DigitalOcean account (`docs/hosted.md`).
- [ ] **Roles.** What people can open in a hosted workspace is set by channels and roles: channels are public or
      private and have managers, and a guest can open only the channels they were added to
      (`docs/hosted.md`). Beyond that everyone who can sign in can do everything: connect or
      disconnect the workspace's Google account, approve or decline what is sent from it, mark
      tasks done, change the agent's name, tone and memories, and set permission rules. A
      self-hosted Hive keeps no member list: whoever your Google OAuth client lets through
      is a member, and nobody can be removed from inside Hive.
      - [ ] Which actions are owner-only.
      - [ ] The agent's shell held to its channel's folder: a private channel and a guest are
            kept from what Hive shows, not from what the agent could be asked to read.
      - [ ] Single-channel guests, guests that expire, and members asking for a guest.
      - [ ] Removing a member, and ending their sessions at once rather than within the hour.
- [ ] Browser access (deferred).
- [ ] Native mobile against the same API.

## Non-goals for now

- Personal OAuth integrations (e.g. Gmail) for workers.
- Horizontal service splitting — the single box serves a small collaborator group. (A hosted
  Hive runs one box per team, not one service split across many.)

Each item needs its own capability boundaries, failure behavior, and end-to-end
evidence before it becomes a supported feature. No dates are promised.
