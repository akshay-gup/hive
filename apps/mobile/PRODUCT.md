# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Small teams, technical and non-technical, who want an agent working alongside them instead of a chat box they use alone. The closed beta is for teams that sign in at app.vi-ak.com, make a workspace and invite colleagues. They open Hive to ask for an outcome, check what the agent is doing, answer its questions, and review finished work. They do this between other tasks, on a laptop or a phone.

Roles in a workspace today: owner, admin, member.

## Product Purpose
Hive is a place where humans and agents collaborate in one space: a team chat with a shared agent, a browser and files of its own, and work that keeps going after the app is closed. Success is a team that hands real work to the agent, stays informed without watching it, and trusts what comes back because it reviewed it.

## Positioning
- One agent the whole team shares. What it is told, remembers, makes and does belongs to the workspace, so a teammate sees the same channels, threads, tasks, files and memories.
- It works on its own computer: a machine with a browser and files, where work continues when nobody is in the app.
- The person stays in control. It asks before risky actions, and finished agent work waits in review until a person marks it done or sends it back with notes.
- Summoned by a mention. Chat is ordinary team chat until someone writes @hive.

## Operating Context
- Channels and threads are the main surface. Replies and @hive mentions fork threads; agent steps appear in the thread where the work happened.
- Delegated tasks run unattended as agent sessions and report back. People also keep plain human tasks on the same board.
- Screens: Chat, Activity (task board), Ideas, Goals, Apps, Calendar, Files, plus the agent's computer.
- Hosted product: each workspace is its own machine, reached through the web app, with Google sign-in. The same app also opens a self-hosted workspace.
- Runs on web, iOS, Android and Mac from one codebase (Expo, React Native). Native playback and screens are not verified on devices yet; the beta is web.

## Capabilities and Constraints
- Terminology in the product: workspace, channel, thread, task, goal, idea, memory, review, "needs you".
- Agent task states people see: queued, running, waiting for input or approval, in review, done, failed, paused, cancelled.
- Ideas are generated from connected email and stay empty until Google is connected; Calendar also needs a Google connection.
- Layout stability is a standing requirement: only the element that changes may move, with fixed slots and placeholders (see recent work on loading states).
- Colours live only in `apps/mobile/src/theme.ts`; a test enforces it.
- Undecided: pricing and billing, public launch date, native app store release.

## Brand Commitments
- Name: Hive. Mascot: a bee, shipped as artwork in `apps/mobile/assets` (still and three animated loops).
- App icon: the bee in a teal hexagon on graphite.
- Voice so far: plain and direct.
- Look: flat, dark graphite. The rail, sidebar and main area are solid regions that meet edge to edge, divided by vertical hairlines only (no horizontal rules under headers); no glass, blur, gradient, glow or shadow (a menu or drawer keeps one). Corner radii on controls, chips, cards and the composer stay as they are. Colours: neutral graphite and grey, soft teal for actions and the active row, amber for needs-review, red for failed. A green-and-honey palette was explored (2026-10-19) but not chosen.

## Evidence on Hand
- Demo recordings in `assets/demos` (they show an earlier mascot, noted in the docs).
- A live demo workspace seeded with a fictional plant shop, "Fern & Fig".
- No customer quotes, benchmarks or published pricing exist. Do not invent any.

## Product Principles
1. The human and the agent share one space; neither is hidden from the other.
2. Show what the agent did and what needs the person, and nothing more.
3. Control stays with the person: review before done, ask before risky.
4. A team member should understand a screen without knowing how agents work.
5. Calm by default: nothing jumps, flickers or nags.
