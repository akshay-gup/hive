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
- **Move goals, ideas, monitors, memories and notices into the chat service.** Projects and tasks are there now; these are still on the machine, and so is the history of a task's runs.
- **A sandbox for channel runs only.** A real wall for other people's requests, at the cost of root for those runs. Only if we decide the agent need not always keep root.
- **Mail and Google credentials.** The workspace's one connection is the whole team's by design, and the agent can read it.

- **Bring the kernel watch to machines made before it.** It comes with the image (the audit package and a unit), so an older machine needs a new workspace; a step in the updater could install it.

## The board in the chat service

- **Recovery sweeps that read the board are gone.** The machine no longer scans for a monitor whose task was never started or an accepted idea whose task was never made; both are made again when the person asks again, and the idea or watch is shown as it is.
- **Notices for a task's outcome are the machine's.** "Ready for your review" and the like are written where the run finished; the room could write them itself, which would show them while the machine sleeps.

## Product

- **Keep a task's run history in the chat service (owed).** Today the app asks the machine for a task's steps, artifacts and browser windows, and the machine checks with the chat service that the person may see the task; none of it shows while the machine sleeps. The machine should send a trimmed copy of each run's steps to the chat service, as chat runs already do, so the history is there when the machine is off. We chose to ship the simpler way first and agreed this is to be done.

- **Create tasks from a private channel.** The board tools are not offered in a private channel yet, though the chat service now holds both the channel's people and the project's and could compare them: the agent would ask which project, and warn once, with names, when the project can be seen by more people than the channel.
- **A bell notice and a live update for agent flags.** Today the owner and admins see a count and a list.
- **Fewer kernel-watch flags per read.** One `ls` of the database folder produced 27 flags, one per file the kernel saw. They should be grouped into one flag per command.
- **A tool row that never finishes after a restart.** When a task is resumed after the machine restarted, the row for the tool that was running stays "running" in the task's history.
- **The agent repeats a request it already did.** Asked in #general to add "Buy milk", then asked something else in the same channel, it added "Buy milk" again. Chat runs may need to know which earlier messages they have already answered.
- **Board tools in chat runs can only create.** The agent can add to-dos but cannot list or read the board, so "what is on the board?" gets "I can't" (kept on purpose for now; the rules make a read call safe).
- **A guest cannot create anything in General.** By the current rules, a guest sees no projects until invited to a channel; say so in the app instead of an empty screen.
- **Pin or favourite projects.**
- **A hint when no agent is connected.**
- **Hide single tasks inside a project.**
- **Drop the channel stamp from goals, memories and notices.** It looks like protection and is not.
- **A short note on project access** (open, limited, private; admin, member, viewer).

## Housekeeping

- **Replace the remaining streaming-client packages with code of our own.**
- **Rotate the Cloudflare and DigitalOcean tokens and the wake key.**
