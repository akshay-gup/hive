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
never finished. Free plan: 25 MB a file, 5 GB in all (`apps/control/src/plans.ts`); only files count, not text.

## Deploying

1. `wrangler r2 bucket create hive-chat-files`; uncomment `r2_buckets` in `apps/chat/wrangler.jsonc`.
2. `wrangler secret put FILE_LINK_KEY` (set already for production), and `CHAT_WAKE_KEY` (the same value on the
   control plane's Worker; `CONTROL_URL` is a var).
3. `CONTROL_PUBLIC_KEY` in `apps/chat/wrangler.jsonc` is the control plane's, from `GET /v1/public-key`.
4. Deploy order: chat Worker, then the control plane (it has `services` -> `hive-chat` and `CHAT_PUBLIC_URL`,
   `CHAT_INTERNAL_URL`), then the web app.
5. Try a staging copy first: `apps/chat/wrangler.staging.jsonc`, then
   `CHAT_URL=... CHAT_KEYS=keys.json pnpm exec tsx scripts/chat-smoke.ts`.

Tests run without Cloudflare: the room's logic takes a small SQL interface (`packages/chat-core/src/sql.ts`),
which Node's SQLite stands in for (`tests/helpers/do-shim.ts`); `tests/helpers/chat-stack.ts` is the Worker with
real rooms and a bucket in memory.

## The agent in channels

`@hive` in a message starts a **run**. The room makes the run and the agent's reply (a message whose author is
the agent, in the thread under the message that asked) in the same transaction as the mention, so there is
never one without the other. The agent works in public channels at once and in a private channel only after a
channel manager switches it on (the `agent` setting); never in a direct message. `@hive` is needed on every
message, and `hive` is reserved so no person has it as a handle.

The workspace's machine holds no key to read chat. It opens **one outbound WebSocket** to the room
(`/w/<workspace>/agent/v1/connect`, subprotocols `hive.runner.v1, <token>`). The token is a `chat-runner` token
(audience `chat:<workspace>:runner`, ten minutes, renewed over the same connection) that the control plane gives the
machine for its own gateway key (`POST /v1/release/:id/runner-token`). It names no person. A newer connection
replaces the old (close code 4409). The machine's frames are checked by the room against a run that is still
going (`apps/chat/src/agent-link.ts`), so all it can do is write that run's own reply, ask people questions, and send
files for the asker; it cannot read a channel, answer for a person or touch another message. The runner's socket is
tagged apart from people's, so it never receives their events.

A run is `queued`, `sent`, `running`, then `done`, `failed` or `stopped`, all in SQLite (`runs`). The room sends a run to
the machine with the thread so far (or the 15 messages before a top-level mention), the channel's name and topic,
who asked, the names in the channel and five-minute links to the files on the message. With no machine connected
the room asks the control plane to start it (`POST /internal/chat/wake/:id`, signed with `CHAT_WAKE_KEY`, at most
once in 30 seconds). The reply is saved at most once a second and shown in between by a `stream` frame that does
not move anyone's place; its `extra` is `{v:1, runId, askedBy, status, reason?, steps, prompts?}`, which the app
reads (`apps/mobile/src/chat-agent-extra.ts`). A person can **stop** a run (who asked, a channel manager, an admin,
the owner) and anyone in the channel but a guest can **answer** what the agent asks (approvals and questions;
the first answer is taken). Runs are re-checked when people, privacy, archive, delete or a sign-in change, and by
the alarm: one nobody takes in two minutes, or that is quiet for ninety seconds without a connection, fails.
Limits (`RUN_LIMITS`): 8 runs per person per ten minutes, 60 per workspace per hour, two at once per channel, eight
waiting, 45 minutes a run, five files a reply.

On the machine (`apps/server/src/chat-runner`): `link.ts` keeps the connection (token, renewal, backoff, a
ping the room answers without waking), `host.ts` runs what it is given as an OpenCode session for the thread in a
stand-in folder for the channel (`stubs.ts`) and reports it, `context.ts` makes what the agent is shown and fetches
the message's files. A chat run always asks first, whatever a channel's folder says, and has only `browse_web`,
`create_issue` and `send_file` (`send_file` puts the file in the reply through the room's own upload path, as the
asker). In a **private channel** it has no board tool: what it makes there would be kept on a machine the channel's
members do not control. A restart of the machine loses its runs; when it connects again and reports
none, the room sends such a run again, up to `RUN_LIMITS.maxAttempts` sends in all, and then fails it
(`lost`) and the person mentions again. The reply keeps what it had: the room sends it back in `run.start`
(`resume`), the machine takes it up into its record, and the agent is told to carry on in the session it
already has (the thread's OpenCode session is kept on the machine's disk). A question that was waiting
is forgotten and asked again if the agent still needs it; a tool call that never returned shows as cut
off. When the agent asks
something, the person who asked is told at once, not at the end; the notice is the run's one notice, and says what
the run is now. A prompt records, from the machine, how many steps and letters of the reply came before it, so the
app shows it where it came up.

**Deleting a channel** takes its messages, threads and files in the chat service, and tells the machine
(`channels.gone`): it removes the agent's sessions in it, its folder, the tasks made or asked for there, and what
the agent learned there, and only for a channel it holds as a stand-in (`createdBy: "chat"`). A machine that was
off asks when it connects (`channels.have`) and is told which of its channels no longer exist, which also clears
stand-ins left from before. The app asks three times: it shows what would go, with numbers, and offers archiving
instead; the person ticks that they understand; and types the channel's name.

What a run is shown stays on the machine's disk (the OpenCode session and the channel's folder) and is readable by
any later run there. That is why a private channel has to be switched on, and why the machine is the workspace's.

## Not built

Presence, search, pins, edit history, multipart uploads over 100 MB, push and email notifications, retention;
for the agent: direct messages, an auto-approve mode and "always allow" rules, choices cards, requests for
uploads, mail, goals and memory in channels,
and keeping the machine awake while it works (a free plan on a host that stops idle machines can stop mid-run; on
DigitalOcean nothing stops). A workspace server still has its own channel records, members and privacy rules, which the app no
longer shows: channels in the app are the chat service's alone. Pictures are made smaller on the web and the
phone.
