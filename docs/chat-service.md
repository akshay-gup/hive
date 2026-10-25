# The chat service

People's conversation (channels, threads, messages, direct messages, reactions, files, who has read what,
who is told) is kept by a Cloudflare Worker of its own, `apps/chat`, and not by the workspace's machine.
The agent runs on that machine with root, so nothing on it can keep a private channel from it; what is not
on the machine cannot be read there. The machine holds no key to the chat service.

## Shape

- **Worker** (`hive-chat`, `chat.vi-ak.com`): stateless. It checks the control plane's token, rate-limits,
  and hands the request to the workspace's room. It also carries files to and from R2.
- **Room**: one SQLite Durable Object per workspace (`ChatRoom`). It holds all chat data and every rule about
  who may see or change it (the same permission code the workspace server used, in `packages/chat-core`).
  One at a time, so reads and writes are consistent. It keeps WebSocket connections through the hibernation
  API, so it costs nothing while quiet. Everything for one workspace is under `/w/<workspace>/...`.
- **R2** (`hive-chat-files`): file bytes under `w/<workspace>/f/<id>`. The room keeps only pointers and a
  running count of stored bytes.

Messages are rows (`messages`: a place in the channel, an author, text, the thread it is in). Channels, people
and notification settings are small JSON records in `records`. A hot channel can later move to a room of its
own: every table is keyed by channel first, and nothing joins across channels.

## Who is who

The control plane signs a **chat token** (`POST /v1/workspaces/:id/chat-token`, EdDSA, ten minutes, audience
`chat:<workspace>`) with the person's role and the plan's file limits. It works while the workspace's machine
is stopped. The app renews it by itself. Other tokens are for one thing each: `chat-revoke` (end someone's
access: tokens made before it stop working), `chat-people` (who is in the workspace, so people can be found for a
direct message before they have opened chat), `chat-purge` (clear a deleted workspace out). The control plane
reaches the chat service through a service binding (`CHAT`), and the Worker never passes on anything of the
caller's except what its own check produced.

## Files and limits

A person asks `POST /v1/files/uploads`; the room checks the channel, the per-file cap and the workspace's
allowance (counting what is already on its way) and returns an address good for that file and exactly that many
bytes. The bytes go to the Worker, which streams them to R2 and tells the room how many arrived; more than was said
throws the file away. Downloads come from a five-minute link the room gives anyone who may open the channel. A
message's or channel's files go with it, and the room's alarm deletes them from R2 and expires uploads that were
never finished. Free plan: 25 MB a file, 10 GB in all (`apps/control/src/plans.ts`); only files count, not text.

## Deploying

1. `wrangler r2 bucket create hive-chat-files`; uncomment `r2_buckets` in `apps/chat/wrangler.jsonc`.
2. `wrangler secret put FILE_LINK_KEY` (set already for production).
3. `CONTROL_PUBLIC_KEY` in `apps/chat/wrangler.jsonc` is the control plane's, from `GET /v1/public-key`.
4. Deploy order: chat Worker, then the control plane (it has `services` -> `hive-chat` and `CHAT_PUBLIC_URL`,
   `CHAT_INTERNAL_URL`), then the web app.
5. Try a staging copy first: `apps/chat/wrangler.staging.jsonc`, then
   `CHAT_URL=... CHAT_KEYS=keys.json pnpm exec tsx scripts/chat-smoke.ts`.

Tests run without Cloudflare: the room's logic takes a small SQL interface (`packages/chat-core/src/sql.ts`),
which Node's SQLite stands in for (`tests/helpers/do-shim.ts`); `tests/helpers/chat-stack.ts` is the Worker with
real rooms and a bucket in memory.

## Not built

The agent in channels (only the route and token shape are reserved: `/agent/v1/*` answers 501, token audience
`chat-run:<workspace>`), presence, search, pins, edit history, multipart uploads over 100 MB, push and email
notifications, retention. A workspace server still has its own channel records, members and privacy rules; they
serve the agent's side (tasks, folders, threads with the agent) and a workspace run without the chat service,
and go when the agent is brought across. Pictures are made smaller on the web only.
