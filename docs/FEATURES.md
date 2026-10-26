# Hive feature inventory

The native and web agent core runs locally. This inventory describes the current implementation and remaining extensions. Live providers and optional infrastructure require separate configuration and validation.

## Implemented coverage

| Area | Current implementation | Remaining extension |
| --- | --- | --- |
| Chat / delegated work | Native CopilotKit chat, server tools, durable tasks and confirmed outcomes | Live model/provider acceptance testing |
| Task review and brief | Agent work waits In Review until a person marks it done or sends it back with a note; the agent cannot close a task. Notes and files (PDF, images, text) on every task are read by each run, and notes added to a running task reach its session | Acceptance testing of live notes against a real `opencode serve` |
| Channels and people | In a hosted workspace, channels are public (found, previewed and joined by anyone but a guest) or private (found only by the people in them), have managers, and people are added, removed, join and leave; a guest is invited with the channels they can open and sees only those, and who is in them | Single-channel guests and guest expiry; the agent's shell is not confined to a channel |
| Project access | As in Jira, a project is open (everyone sees it and works on its tasks), limited (everyone sees it, its members work on it) or private (only its members see it or its tasks); its people are admins, members or viewers, and the owner and admins of the workspace see every project. The server enforces it for the app and for the agent; a guest sees only the projects they are named in | Hiding single tasks inside a project (issue-level security); per-person visibility of tasks outside a project |
| Channel files | A Files browser per channel (recent changes, folders, upload) with previews by kind; the agent shares files as cards (`send_file`) and asks for them with an upload button and modal (`request_upload`); expiring links keep their scope in the path, and a web page runs in a sandbox with its own folder | Delete/rename and drag and drop; relative images in Markdown; native video/audio player |
| Ideas / personality and memory | Source-backed mail/goal rules, accept/edit/dismiss, the agent's name, tone and avatar, and editable/forgettable memories, shared by the team | Broader model-derived cross-connector suggestions |
| Goals / Tracking | Milestones, recurring watches, observations, retry/backoff, pause and cancellation | Adaptive long-term planning and calendar-driven reminders |
| Browser | Persistent Chromium, public page reads, snapshots, console takeover, PDF downloads | Autonomous interactive booking and per-person VM orchestration |
| Gmail / Calendar | Google OAuth; complete threads; saved drafts; calendar/event CRUD with reviewed versions | Live Google acceptance, recurrence editing, other connectors |
| PDF job | Durable import, typed input request, filled-copy preview, reviewed reply, receipt | OCR/scanned forms and additional PDF field types |
| Generated results | Plans/reports/comparisons, finance CSV metrics, and scripts saved as artifacts | Managed tool installation/versioning and image/audio generation |
| Notifications | Durable in-app inbox, source-linked change alerts, restart reconciliation | APNs/FCM/device push delivery |
| Connectors | Searchable capability/status catalogue, Google connection, browser worker | Plaid, health, Instagram, WhatsApp and partner APIs |

The implementation and validation details are in [VERIFICATION.md](VERIFICATION.md). Planned extensions are not claims of current support. Priorities are tracked in the [roadmap](../ROADMAP.md).
