# Later

Things we have talked about and chosen to leave for now, each with why it waits and what would bring it back. When one is built, take it off this list.

## Watching and containing the agent

The agent runs on the workspace's machine with root, so these narrow what it can reach or make what it reaches visible. None of them is a lock; see [SECURITY.md](../SECURITY.md#hosted-workspaces).

- **Block at the open with kernel permission events (`fanotify`).** The kernel watch (the audit system) marks a read just after it happens and stops the run from then on, so a single command that reads and sends in one go gets through. A watcher that answers each open of the protected files (allow the server, deny the rest) stops that, and stops hidden paths too. It needs a small helper program and the protected data on a mount of its own. Worth doing if people come to rely on private channels and projects.
- **Watch other channels' folders (`owners/`).** They sit in the agent's own work area, so watching the whole tree logs a run's own installs. Needs rules made per channel as runs start, or the permission-event watcher above.
- **Watch `/etc/hive`.** The updater reads it on a timer, so it needs an allow-list by service before the kernel watch can include it. The text check and the refusing rule cover it meanwhile.
- **Admin approval for flagged commands.** A card shown to an owner or admin, not only to the asker. Needs a rule for admins who are not in a private channel.
- **A separate user for the server's data.** The agent keeps `sudo`, but reading the data then takes a visible, logged `sudo`; add sudo input/output logging. A speed bump, not a wall.
- **Model provider keys behind a proxy.** The agent would hold a placeholder, not the real key.
- **Clear a run's work folder after a chat run.** Less left on disk for a later run to read.
- **Personal chat history off the machine.** Each person's private chat with the agent is on the machine today.
- **Move projects, tasks and goals into the chat service.** Would make private projects private from the agent. Left because of its size and the files that go with tasks; revisit if real secrecy is needed.
- **A sandbox for channel runs only.** A real wall for other people's requests, at the cost of root for those runs. Only if we decide the agent need not always keep root.
- **Mail and Google credentials.** The workspace's one connection is the whole team's by design, and the agent can read it.

- **Bring the kernel watch to machines made before it.** It comes with the image (the audit package and a unit), so an older machine needs a new workspace; a step in the updater could install it.

## Product

- **Create tasks from a private channel.** The agent asks which project, and warns once, with names, when the project can be seen by more people than the channel. The chat service does the comparison from project data the machine sends one way, so the machine never learns a private channel's members.
- **A bell notice and a live update for agent flags.** Today the owner and admins see a count and a list.
- **Pin or favourite projects.**
- **A hint when no agent is connected.**
- **Hide single tasks inside a project.**
- **Drop the channel stamp from goals, memories and notices.** It looks like protection and is not.
- **A short note on project access** (open, limited, private; admin, member, viewer).

## Housekeeping

- **Replace the remaining streaming-client packages with code of our own.**
- **Rotate the Cloudflare and DigitalOcean tokens and the wake key.**
