# Later

Things we have talked about and chosen to leave for now, each with why it waits and what would bring it back. When one is built, take it off this list.

## Watching and containing the agent

The agent runs on the workspace's machine with root, so these narrow what it can reach or make what it reaches visible. None of them is a lock; see [SECURITY.md](../SECURITY.md#hosted-workspaces).

- **Block at the open with kernel permission events (`fanotify`).** The kernel watch (the audit system) marks a read just after it happens and stops the run from then on, so a single command that reads and sends in one go gets through. A watcher that answers each open of the protected files (allow the server, deny the rest) stops that, and stops hidden paths too. It needs a small helper program and the protected data on a mount of its own. Worth doing if people come to rely on private channels and projects.
- **Admin approval for flagged commands.** A card shown to an owner or admin, not only to the asker. Needs a rule for admins who are not in a private channel.
- **A separate user for the server's data.** The agent keeps `sudo`, but reading the data then takes a visible, logged `sudo`; add sudo input/output logging. A speed bump, not a wall.
- **Model provider keys behind a proxy.** The agent would hold a placeholder, not the real key.
- **Clear a run's work folder after a chat run.** Less left on disk for a later run to read.
- **Wipe the agent's session of a personal chat after each run.** The chat itself is kept by the chat service, but the agent's own session of it stays on the machine's disk for the next run to continue, and a run with root can read it. Deleting it after each run and giving the next run the chat back from the room would close that, at the cost of the agent's tool memory and longer prompts.
- **Take the older own-chat code off the machine.** The machine still has the page-driven chat (`/api/conversation`, the opencode run routes, the board ticket, `where: own` routines) for workspaces with no chat service; it can go if local mode is dropped.
- **Choice cards and upload requests in the personal chat.** The first chat had `present_choices` and `request_upload`; the personal channel does not offer them yet.
- **A sandbox for channel runs only.** A real wall for other people's requests, at the cost of root for those runs. Only if we decide the agent need not always keep root.
- **Mail and Google credentials.** The workspace's one connection is the whole team's by design, and the agent can read it.

- **Bring the kernel watch to machines made before it.** It comes with the image (the audit package and a unit), so an older machine needs a new workspace; a step in the updater could install it.

## The board in the chat service


## Product

- **Keep a task's run history in the chat service (owed).** Today the app asks the machine for a task's steps, artifacts and browser windows, and the machine checks with the chat service that the person may see the task; none of it shows while the machine sleeps. The machine should send a trimmed copy of each run's steps to the chat service, as chat runs already do, so the history is there when the machine is off. We chose to ship the simpler way first and agreed this is to be done.

- **No terms, privacy or pricing anywhere before or after signing in.** /terms, /privacy and /pricing answer 200 with the sign-in page. A person deciding whether to trust it finds nothing about where data lives, who can read it (the agent has root) or what it costs. The account page can delete the account but not export.
- **Unexplained shorthand in the app.** "Needs you", "3/3" beside a monitor, ages like "44m", "Computer · take control", and "Delegate" and "Computer" in the left bar still need plain names (waiting on the names).
- **Terms, Privacy and pricing pages** (waiting on the text and the pricing).
- **Tap targets on a phone are bigger to touch, not to look at.** The small buttons now reach 8 px further; a careful redesign could make them taller.
- **More ways to wake a routine.** Time and a web address work; events the room already sees (a task finishing, a message in a channel, a file added) are the next triggers. A routine could also be made from the app, not only by the agent.
- **A routine's web address is a secret in the agent's reply.** The agent is told to give it only to the person who asked; it could instead be shown only in the app.
- **Pin or favourite projects.**
- **A hint when no agent is connected.**
- **Hide single tasks inside a project.**

## Possible later

- **Goal ownership.** Goals do not need an owner for now. They stay shared within their scope: anyone who can work in that scope can change, pause or finish them. Consider adding an owner later if needed.

## Housekeeping

- **Replace the remaining streaming-client packages with code of our own.**
- **Rotate the Cloudflare and DigitalOcean tokens and the wake key.**
