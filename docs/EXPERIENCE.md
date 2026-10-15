# Hive interaction design

Hive keeps conversation, ongoing work, and user control together in a shared native and web interface.

## Conversation and work

- One main conversation is the default. With CopilotKit Rich Threads enabled, its identifier is saved in the workspace; side chats have separate conversation context.
- The composer stays available during replies. Its send arrow changes to a stop square in the same position inside the input pill, then returns when the run ends. Stopping preserves the current draft.
- Follow-ups appear in a visible queue and run in order. Stopping a reply pauses that queue; it does not cancel delegated tasks. A new submission can continue immediately when no follow-ups are held. An existing paused queue resumes through **Send queued messages**.
- Open chats and their drafts remain mounted while navigating. Queued messages are held in the open app, not a server inbox; keep the app open until they are sent. Delegated tasks are durable server work.
- Reading older messages should not force a scroll to the latest reply. A latest-message control returns to the live conversation.
- While the agent works in a thread, a quiet line says what it is doing now (“Working · Fetching techcrunch.com”). Afterwards it reads “Worked through 3 steps · 1 didn't work” and opens into the steps, with the reason for any that failed. Tools that have a card of their own (mail, the browser, files, choices) keep it, and work saved as a task has its own card and page.
- On a wide window a channel thread opens beside the channel, as a panel of its own. Drag the gap between them, use the arrow keys, or press the expand button to make it wider, and double-click the gap to put it back. The width is kept on the device. Narrow windows and phones open the thread over the channel.

## Transparency and control

- Tap the avatar to see activity, reviews and receipts. Its status names the current work or the input it needs.
- Background updates show meaningful completions or requests for input. They link to the saved task and can be dismissed.
- Structured review screens retain the exact recipient, action and accept/reject controls. Reading a public page requires no extra review.
- The agent's name, tone and memory are editable in Apps. Goals, tracking and artifacts remain usable outside chat.

## Visual language

The look is Graphite: quiet dark glass. Panels are faint white over a neutral charcoal backdrop that is a shade lighter at the top left, each with a hairline, a rim that catches more light along its top and left edges, and a soft shadow; nothing glows. On a wide window the sidebar, the main area and a channel's thread are separate panels with room between them; on a phone the header and tab bar float over the backdrop. The web draws the backdrop as a picture made on the spot, rounding each pixel with a little noise so a gradient this slow and dark has no visible bands, and a sheet blurs the page behind it; native has no blur here and draws a slightly more opaque fill. The row you are on in the sidebar is a faint lens, the composer is a floating pill, and a calm teal marks actions and links; amber, green and red appear only for what they mean. In the agent chat the person's messages sit in a teal-tinted bubble and the agent's are plain text. Large touch targets, rounded input and navigation pills, and restrained artifact frames keep attention on the work. Email, browser and PDF previews show actual tool results, and a web page or document shown in a frame keeps a white page. Hive uses an original honey-amber bee, bundled locally; sky, sand and lilac backgrounds preserve the avatar color preference. See [artwork provenance](../apps/mobile/assets/README.md).

## Boundaries

The browser worker provides persistent Chromium and documents for public web access. Live Rich Threads, model reasoning and Google accounts require credentials.
