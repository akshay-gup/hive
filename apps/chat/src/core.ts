import { Hono } from "hono";
import { z } from "zod";
import {
  Access,
  canOpen,
  canSeeTask,
  canViewProject,
  isDm,
  managesChannel,
  type Person,
} from "../../../packages/chat-core/src/access.ts";
import { AgentFlags } from "../../../packages/chat-core/src/agent-flags.ts";
import { ChannelPeople } from "../../../packages/chat-core/src/channel-people.ts";
import { ChatChannels } from "../../../packages/chat-core/src/channels.ts";
import { DirectMessages } from "../../../packages/chat-core/src/direct-messages.ts";
import { Entries, type Entry } from "../../../packages/chat-core/src/entries.ts";
import { EntryRules } from "../../../packages/chat-core/src/entry-rules.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import { type ChatEvent, Events } from "../../../packages/chat-core/src/events.ts";
import { Files } from "../../../packages/chat-core/src/files.ts";
import { Messages } from "../../../packages/chat-core/src/messages.ts";
import { Notifications } from "../../../packages/chat-core/src/notifications.ts";
import { Reactions } from "../../../packages/chat-core/src/reactions.ts";
import { Reads } from "../../../packages/chat-core/src/reads.ts";
import { Runs } from "../../../packages/chat-core/src/runs.ts";
import { migrate } from "../../../packages/chat-core/src/schema.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import { first, type Sql } from "../../../packages/chat-core/src/sql.ts";
import { SqliteRecordStore } from "../../../packages/chat-core/src/sqlite-store.ts";
import { Projects, Tasks } from "../../../packages/chat-core/src/work.ts";
import { Work } from "../../../packages/chat-core/src/work-rules.ts";
import type { Channel, ChannelFootprint } from "../../../packages/domain/src/agent.ts";
import { WATCH_MODES } from "../../../packages/domain/src/agent-watch.ts";
import type { ChatMessage } from "../../../packages/domain/src/chat.ts";
import { choiceSchema } from "../../../packages/domain/src/chat-agent.ts";
import { plainIssues } from "../../../packages/domain/src/friendly-issues.ts";
import type { WorkspaceRole } from "../../../packages/integrations/src/workspace-token.ts";
import { AgentLink, type RunnerLink } from "./agent-link.ts";
import { Filing } from "./filing.ts";
import { Messaging } from "./messaging.ts";
import { WorkNotices } from "./work-notices.ts";

/** Who is asking, as the Worker verified it from the control plane's token. */
export interface ChatIdentity {
  sub: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  /** When the token was made, in milliseconds. */
  issuedAt: number;
  limits?: { maxFileBytes: number; storageBytes: number };
  /** The workspace this is for, which the Worker knows from the address. */
  workspaceId?: string;
  /** When the token runs out, in milliseconds: the end of a connection made with it. */
  expiresAt?: number;
}

interface Variables {
  owner: string;
  identity: ChatIdentity;
}
type Bindings = { identity: ChatIdentity };

/**
 * One workspace's chat: its data and every rule about who may see or change it. It knows nothing of
 * Cloudflare (a Durable Object hands it a SQL connection and who is asking), so the same code runs in
 * the tests on Node's SQLite. A request is one call into it, and nothing in it waits on anything but
 * the database, which is what makes each call whole.
 */
export class ChatCore {
  readonly store: SqliteRecordStore;
  readonly access: Access;
  readonly people: ChannelPeople;
  readonly dms: DirectMessages;
  readonly messages: Messages;
  readonly reactions: Reactions;
  readonly reads: Reads;
  readonly notices: Notifications;
  readonly events: Events;
  readonly channels: ChatChannels;
  readonly files: Files;
  readonly filing: Filing;
  readonly messaging: Messaging;
  readonly runs: Runs;
  readonly tasks: Tasks;
  readonly projects: Projects;
  readonly entries: Entries;
  readonly rules: EntryRules;
  readonly workNotices: WorkNotices;
  readonly work: Work;
  /** When each task running on the machine was last announced. */
  private readonly touched = new Map<string, number>();
  readonly flags: AgentFlags;
  readonly agent: AgentLink;
  private readonly publishEvent: (event: ChatEvent) => void;
  private readonly workQueued: () => void;
  readonly app: Hono<{ Bindings: Bindings; Variables: Variables }>;

  constructor(
    readonly sql: Sql,
    options: {
      now?: () => string;
      clock?: () => number;
      /** Told of each event once what it is about has been written, for whoever is listening. */
      publish?: (event: ChatEvent) => void;
      /** The key the addresses for sending and fetching files are signed with. */
      linkKey?: () => string | undefined;
      /** There is something for the bucket to do soon (files to delete, uploads to expire). */
      workQueued?: () => void;
      /** The agent's machine, if it is connected. */
      runner?: () => RunnerLink | null;
      /** A message as it is while the agent writes it, to be shown and not kept. */
      stream?: (channelId: string, message: ChatMessage) => void;
      /** This workspace's id, once the room knows it. */
      workspaceId?: () => string | null;
      /** Ask for the agent's machine to be started. */
      wake?: () => void;
    } = {},
  ) {
    this.publishEvent = (event) => {
      try {
        options.publish?.(event);
      } catch (error) {
        console.error(`[Hive chat] could not send an event: ${String(error)}`);
      }
    };
    const now = options.now ?? (() => new Date().toISOString());
    migrate(sql);
    this.store = new SqliteRecordStore(sql, now);
    // Roles come with every token, so this workspace always knows its people.
    this.access = new Access(this.store, true);
    this.people = new ChannelPeople(this.store, this.access);
    this.dms = new DirectMessages(this.store, this.access, async () => undefined);
    this.messages = new Messages(sql, now);
    this.reactions = new Reactions(sql, now);
    this.reads = new Reads(sql, now);
    this.notices = new Notifications(sql, now);
    this.events = new Events(sql, options.clock);
    this.channels = new ChatChannels(this.store, this.access, this.messages, this.reads, now);
    this.files = new Files(sql, now, options.clock);
    const workQueued = () => {
      try {
        options.workQueued?.();
      } catch (error) {
        console.error(`[Hive chat] could not queue work: ${String(error)}`);
      }
    };
    this.workQueued = workQueued;
    this.filing = new Filing({
      store: this.store,
      access: this.access,
      files: this.files,
      events: this.events,
      publish: this.publishEvent,
      linkKey: options.linkKey ?? (() => undefined),
      workQueued,
      taskVisible: async (owner, taskId) => void (await this.work.getTask(owner, taskId)),
      fileGone: (file) => {
        if (!file.messageId) return;
        const message = this.messages.get(file.messageId);
        if (message) void this.messaging.refresh(message.id);
      },
    });
    this.messaging = new Messaging({
      files: this.files,
      workQueued,
      sql,
      store: this.store,
      access: this.access,
      channels: this.channels,
      messages: this.messages,
      reactions: this.reactions,
      reads: this.reads,
      notices: this.notices,
      events: this.events,
      publish: this.publishEvent,
    });
    this.runs = new Runs(sql, options.clock);
    this.tasks = new Tasks(sql, options.clock);
    this.projects = new Projects(sql, options.clock);
    this.entries = new Entries(sql, options.clock);
    this.rules = new EntryRules({
      access: this.access,
      entries: this.entries,
      projects: this.projects,
      channelOf: (id) => this.store.get<Channel>(SHARED_OWNER, "channels", id),
      changed: (entry, removed, audience) => void this.entryChanged(entry, removed, audience),
    });
    this.workNotices = new WorkNotices({
      entries: this.entries,
      rules: this.rules,
      wantsWork: async (owner) => (await this.channels.notificationPrefs(owner)).work,
      emit: (type, data, userId) => this.emit(type, data, { userId }),
    });
    this.work = new Work({
      access: this.access,
      projects: this.projects,
      tasks: this.tasks,
      clock: options.clock ?? Date.now,
      files: this.files,
      fileLink: (fileId) => {
        const workspace = options.workspaceId?.();
        return workspace ? this.filing.taskFileLink(workspace, fileId) : null;
      },
      filesGone: workQueued,
      channel: async (id) => {
        const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", id);
        return channel && channel.status !== "archived" ? channel : null;
      },
      discussion: async (channelId) => {
        const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", channelId);
        const recent = this.messages
          .since(channelId, Math.max(0, this.messages.lastSeq(channelId) - 15), 15)
          .filter((m) => !m.deletedAt && m.body.trim());
        if (!recent.length) return null;
        const known = await this.access.byId();
        const lines = recent.map((m) => {
          const who =
            m.authorKind === "agent" ? "Hive" : known.get(m.authorId)?.name?.trim() || "Someone";
          return `${who}: ${m.body.trim().slice(0, 500)}`;
        });
        return { name: channel?.name ?? channelId, lines: lines.join("\n") };
      },
      changed: ({ task, before, removed }) => {
        void this.workChanged("task.changed", task, removed);
        void this.agent.taskChanged(task, before, removed);
        if (!removed) this.workNotices.taskChanged(task, before);
      },
      projectChanged: (project, removed) =>
        void this.workChanged("project.changed", project, removed),
      // What was kept for a project goes with it (the app has warned who deletes it).
      projectGone: async (id) => void (await this.rules.removeScope({ type: "project", id })),
    });
    this.flags = new AgentFlags(sql, options.clock);
    this.agent = new AgentLink({
      store: this.store,
      flags: this.flags,
      access: this.access,
      messages: this.messages,
      runs: this.runs,
      tasks: this.tasks,
      work: this.work,
      files: this.files,
      filing: this.filing,
      runner: () => options.runner?.() ?? null,
      show: (message) => this.messaging.show(message),
      stream: (channelId, message) => options.stream?.(channelId, message),
      edited: (message) => this.emit("message.edited", message, { channelId: message.channelId }),
      notifyEnd: (run, reply) => this.messaging.runEnded(run, reply),
      notifyAsk: (run, reply) => this.messaging.runAsked(run, reply),
      taskTouched: (task, quiet) => {
        // Progress comes often; the screen is told of it now and then, and of anything else at once.
        const now = (options.clock ?? Date.now)();
        if (quiet && now - (this.touched.get(task.id) ?? 0) < 3_000) return;
        this.touched.set(task.id, now);
        void this.workChanged("task.changed", task);
      },
      workspaceId: () => options.workspaceId?.() ?? null,
      linkKey: options.linkKey ?? (() => undefined),
      soon: workQueued,
      wake: () => {
        try {
          options.wake?.();
        } catch (error) {
          console.error(`[Hive chat] could not wake the agent: ${String(error)}`);
        }
      },
      clock: options.clock ?? Date.now,
    });
    this.messaging.useAgent(this.agent);
    this.app = this.routes();
  }

  /** Note who is asking: the token is the control plane's word on their name and role, so it is kept as it says. */
  private async remember(identity: ChatIdentity): Promise<Person> {
    const email = identity.email.trim().toLowerCase();
    const known = await this.store.get<{ email?: string; name?: string; role?: string }>(
      "system",
      "users",
      identity.sub,
    );
    if (known?.email !== email || known?.name !== identity.name || known?.role !== identity.role)
      await this.store.put("system", "users", {
        id: identity.sub,
        email,
        name: identity.name,
        role: identity.role,
      });
    return { id: identity.sub, email, name: identity.name, role: identity.role };
  }

  /** Write an event down and tell whoever is listening. */
  emit(type: string, data: unknown, scope: { channelId?: string | null; userId?: string | null }) {
    this.publishEvent(this.events.append(type, data, scope));
  }

  /**
   * Take a channel away with everything in it: its messages, what was said to whom, and its files (the
   * bucket's copies go when the room next clears them). For the channel's managers, an admin or the owner
   * who can open it; a direct message is never deleted.
   */
  async deleteChannel(owner: string, channelId: string): Promise<{ ok: true }> {
    const person = await this.access.person(owner);
    const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!person || !channel) throw new AppError("Channel not found", 404);
    if (isDm(channel)) throw new AppError("A direct message can't be deleted", 409);
    if (!managesChannel(person, channel))
      throw new AppError("Only a channel manager, an admin or the owner can delete a channel", 403);
    const audience = await this.audience(channelId);
    await this.rules.removeScope({ type: "channel", id: channelId });
    this.sql.transaction(() => {
      this.files.removeOfChannel(channelId);
      this.sql.run("DELETE FROM reactions WHERE channel_id = ?", channelId);
      this.sql.run("DELETE FROM notifications WHERE channel_id = ?", channelId);
      this.sql.run("DELETE FROM reads WHERE channel_id = ?", channelId);
      this.sql.run("DELETE FROM messages WHERE channel_id = ?", channelId);
      this.sql.run("DELETE FROM channel_state WHERE channel_id = ?", channelId);
      this.sql.run(
        "DELETE FROM records WHERE owner = ? AND kind = 'channels' AND id = ?",
        SHARED_OWNER,
        channelId,
      );
    });
    // Whoever could open it is told it is gone (the channel itself no longer says who they were).
    for (const userId of audience) this.emit("channel.removed", { id: channelId }, { userId });
    await this.agent.channelGone(channelId);
    this.workQueued();
    return { ok: true };
  }

  /**
   * What a channel holds, for the person about to delete it: they are shown what would go. For those
   * who may delete it.
   */
  async channelFootprint(owner: string, channelId: string): Promise<ChannelFootprint> {
    const person = await this.access.person(owner);
    const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!person || !channel || !canOpen(person, channel))
      throw new AppError("Channel not found", 404);
    if (isDm(channel) || !managesChannel(person, channel))
      throw new AppError("Only a channel manager, an admin or the owner can delete a channel", 403);
    const count = (query: string) => first<{ n: number }>(this.sql, query, channelId)?.n ?? 0;
    return {
      messages: count(
        "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND deleted_at IS NULL",
      ),
      threads: count(
        "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND reply_count > 0 AND deleted_at IS NULL",
      ),
      files: count("SELECT COUNT(*) AS n FROM files WHERE channel_id = ? AND state = 'ready'"),
      fileBytes: count(
        "SELECT COALESCE(SUM(bytes), 0) AS n FROM files WHERE channel_id = ? AND state = 'ready'",
      ),
      people: (await this.access.openers(channel)).length,
      agentRuns: count("SELECT COUNT(*) AS n FROM runs WHERE channel_id = ?"),
    };
  }

  /** The ids of the people who may open a channel now; none for one that does not exist. */
  private async audience(channelId: string): Promise<Set<string>> {
    const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel) return new Set();
    return new Set((await this.access.openers(channel)).map((who) => who.owner));
  }

  /**
   * A task or project changed: each person who may see it is told which, so their screen asks again. The
   * event carries no more than the id; what they may be shown is decided when they ask.
   */
  private async workChanged(
    type: "task.changed" | "project.changed",
    thing: { id: string; projectId?: string | null },
    removed = false,
  ) {
    const project =
      type === "task.changed"
        ? thing.projectId
          ? this.projects.get(thing.projectId)
          : null
        : (thing as { id: string });
    for (const [id, who] of await this.access.byId()) {
      const person = { id, ...who };
      // A project that was removed is no one's any more; everyone who could see it is told it went.
      const sees =
        type === "task.changed"
          ? canSeeTask({ person, allows: () => true }, project as never)
          : removed || canViewProject(person, project as never);
      if (sees)
        this.emit(type, { id: thing.id, ...(removed ? { removed: true } : {}) }, { userId: id });
    }
  }

  /**
   * An entry (a notice, a goal, a routine) changed: each person who may see it is told its id, so their screen
   * asks again. A removed one is told to those who could see it when it went.
   */
  private async entryChanged(entry: Entry, removed = false, audience?: string[]) {
    for (const userId of audience ?? (await this.rules.audience(entry)))
      this.emit(
        "entry.changed",
        { id: entry.id, kind: entry.kind, ...(removed ? { removed: true } : {}) },
        { userId },
      );
  }

  /** A channel was made: those who can open it are told. */
  private announce(type: "channel.new" | "channel.updated", channelId: string) {
    this.emit(type, { id: channelId }, { channelId });
  }

  private async announceChange(channelId: string, before: Set<string>) {
    const after = await this.audience(channelId);
    this.emit("channel.updated", { id: channelId }, { channelId });
    for (const userId of before)
      if (!after.has(userId)) this.emit("channel.removed", { id: channelId }, { userId });
    // A run whose asker can no longer ask (or whose channel no longer has the agent) stops.
    await this.agent.recheck(channelId);
  }

  /**
   * Make the workspace's people exactly these: the control plane says who is in the workspace, so
   * they can be found for a direct message before they have opened chat. Anyone it no longer names is
   * taken out of the list (their access has been ended separately).
   */
  async syncPeople(
    people: { sub: string; email: string; name: string; role: WorkspaceRole }[],
  ): Promise<void> {
    const wanted = new Map(people.map((p) => [p.sub, p]));
    for (const existing of await this.store.list<{ id: string }>("system", "users"))
      if (!wanted.has(existing.id)) await this.store.remove("system", "users", existing.id);
    for (const p of wanted.values()) await this.remember({ ...p, issuedAt: 0 } as ChatIdentity);
  }

  /** Note who this is, as their token says. */
  async syncPerson(identity: ChatIdentity): Promise<void> {
    await this.remember(identity);
  }

  handle(request: Request, identity: ChatIdentity): Promise<Response> | Response {
    return this.app.fetch(request, { identity });
  }

  private routes() {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.onError((error, c) => {
      if (error instanceof z.ZodError) return c.json({ error: plainIssues(error.issues) }, 422);
      if (error instanceof AppError) return c.json({ error: error.message }, error.status);
      if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
      console.error(`[Hive chat] ${error.name}: ${error.message}`);
      return c.json({ error: "Request failed. Try again." }, 500);
    });
    app.use("*", async (c, next) => {
      const identity = c.env.identity;
      await this.remember(identity);
      // The plan's numbers come with the token, and a newer token's win.
      if (identity.limits) this.files.setLimits(identity.limits, identity.issuedAt);
      c.set("identity", identity);
      c.set("owner", identity.sub);
      await next();
    });

    // Whatever names a channel its person may not open is refused as if it were not there.
    const open = async (
      c: { get(key: "owner"): string; req: { param(name: string): string } },
      next: () => Promise<void>,
    ) => {
      await this.access.assertChannel(c.get("owner"), c.req.param("id"));
      await next();
    };
    app.use("/v1/channels/:id", open);
    app.use("/v1/channels/:id/*", open);

    const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => ({}));

    // The board: projects and tasks, and who may see and change them.
    const owner = (c: { get(key: "owner"): string }) => c.get("owner");
    // What the app gives the machine so the agent can change the board in the app's own chat with it.
    app.get("/v1/work/ticket", (c) => c.json(this.agent.boardTicket(owner(c))));
    app.get("/v1/work", async (c) =>
      c.json({
        tasks: await this.work.tasksFor(owner(c)),
        projects: await this.work.projectsFor(owner(c)),
      }),
    );
    app.get("/v1/projects/people", async (c) => c.json(await this.work.projectPeople(owner(c))));
    app.post("/v1/projects", async (c) =>
      c.json(await this.work.createProject(owner(c), await c.req.json()), 201),
    );
    app.patch("/v1/projects/:id", async (c) =>
      c.json(await this.work.updateProject(owner(c), c.req.param("id"), await c.req.json())),
    );
    app.delete("/v1/projects/:id", async (c) =>
      c.json(await this.work.deleteProject(owner(c), c.req.param("id"), await body(c))),
    );
    app.post("/v1/tasks", async (c) =>
      c.json(await this.work.createTask(owner(c), await c.req.json()), 201),
    );
    app.get("/v1/tasks/:id", async (c) =>
      c.json({
        task: (
          await this.work.present(owner(c), [await this.work.getTask(owner(c), c.req.param("id"))])
        )[0],
      }),
    );
    // What only the machine keeps of a task (the steps of its runs, what it made, its browser windows), for a
    // person who may see the task; the room checks that, and the machine is asked while it is awake.
    app.get("/v1/tasks/:id/run", async (c) => {
      const me = owner(c);
      const task = await this.work.getTask(me, c.req.param("id"));
      try {
        return c.json({
          awake: true,
          ...((await this.agent.askMachine(task, me)) as object),
        });
      } catch (error) {
        // Reading old history is not worth starting a machine for.
        if (error instanceof AppError && error.status === 503) return c.json({ awake: false });
        throw error;
      }
    });
    app.patch("/v1/tasks/:id", async (c) =>
      c.json(await this.work.updateTask(owner(c), c.req.param("id"), await c.req.json())),
    );
    app.delete("/v1/tasks/:id", async (c) =>
      c.json(await this.work.deleteTask(owner(c), c.req.param("id"))),
    );
    // A task's files: asked for room first (the task's limits), then sent to the address given, then put on the task.
    app.post("/v1/tasks/:id/attachments/begin", async (c) => {
      const id = c.req.param("id");
      const checked = await this.work.beginAttachment(owner(c), id, await c.req.json());
      return c.json(
        await this.filing.beginTaskFile(owner(c), c.get("identity").workspaceId ?? "", id, checked),
        201,
      );
    });
    app.post("/v1/tasks/:id/attachments", async (c) => {
      const { fileId } = z.object({ fileId: z.string().min(1).max(100) }).parse(await c.req.json());
      return c.json(await this.work.addAttachment(owner(c), c.req.param("id"), fileId), 201);
    });
    app.delete("/v1/tasks/:id/attachments/:fileId", async (c) =>
      c.json(await this.work.removeAttachment(owner(c), c.req.param("id"), c.req.param("fileId"))),
    );
    app.post("/v1/tasks/:id/accept", async (c) =>
      c.json(await this.work.accept(owner(c), c.req.param("id"))),
    );
    app.post("/v1/tasks/:id/delegate", async (c) => {
      const body = z
        .object({
          target: z.string().trim().min(1).max(80),
          reason: z.string().trim().min(1).max(500).optional(),
        })
        .parse(await c.req.json());
      return c.json(
        await this.work.delegate(owner(c), c.req.param("id"), body.target, body.reason),
      );
    });
    app.post("/v1/tasks/:id/control", async (c) => {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
        .parse(await c.req.json());
      return c.json(await this.work.control(owner(c), c.req.param("id"), action));
    });
    app.post("/v1/tasks/:id/input", async (c) => {
      const input = z
        .object({
          answer: z.string().trim().min(1).max(12000),
          fields: z
            .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
            .optional(),
        })
        .parse(await c.req.json());
      return c.json(
        await this.work.answer(owner(c), c.req.param("id"), input.answer, input.fields),
      );
    });
    app.post("/v1/tasks/:id/notes", async (c) =>
      c.json(await this.work.addNote(owner(c), c.req.param("id"), await c.req.json()), 201),
    );
    app.delete("/v1/tasks/:id/notes/:noteId", async (c) =>
      c.json(await this.work.removeNote(owner(c), c.req.param("id"), c.req.param("noteId"))),
    );

    app.get("/v1/me", (c) => {
      const { sub, email, name, role, limits } = c.get("identity");
      return c.json({ id: sub, email, name, role, limits });
    });

    // Channels
    app.get("/v1/channels", async (c) => c.json(await this.channels.list(c.get("owner"))));
    app.post("/v1/channels", async (c) => {
      const channel = await this.channels.create(c.get("owner"), await body(c));
      this.announce("channel.new", channel.id);
      return c.json(channel, 201);
    });
    app.get("/v1/channels/:id", async (c) =>
      c.json(await this.channels.get(c.get("owner"), c.req.param("id"))),
    );
    app.get("/v1/channels/:id/members", async (c) =>
      c.json(await this.people.get(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/channels/:id/members", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      const result = (await this.people.change(c.get("owner"), id, await body(c))) ?? {
        left: true,
      };
      await this.announceChange(id, before);
      return c.json(result);
    });
    app.post("/v1/channels/:id/managers", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      const result = await this.people.managers(c.get("owner"), id, await body(c));
      await this.announceChange(id, before);
      return c.json(result);
    });
    app.patch("/v1/channels/:id", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      const result = await this.people.settings(c.get("owner"), id, await body(c));
      await this.announceChange(id, before);
      return c.json(result);
    });
    app.get("/v1/channels/:id/footprint", async (c) =>
      c.json(await this.channelFootprint(c.get("owner"), c.req.param("id"))),
    );
    app.delete("/v1/channels/:id", async (c) =>
      c.json(await this.deleteChannel(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/channels/:id/archive", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      const result = await this.channels.archive(c.get("owner"), id);
      await this.announceChange(id, before);
      return c.json(result);
    });
    app.get("/v1/channels/:id/mentionable", async (c) =>
      c.json(await this.channels.mentionable(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/channels/:id/read", async (c) => {
      const { seq } = z.object({ seq: z.number().int().min(0).optional() }).parse(await body(c));
      const at = await this.messaging.markRead(c.get("owner"), c.req.param("id"), seq);
      return c.json({ ok: true, seq: at });
    });

    // What is said in a channel
    const number = (value: string | undefined) => {
      if (value === undefined || value === "") return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new AppError("That is not a number", 422);
      return n;
    };
    app.get("/v1/channels/:id/messages", async (c) =>
      c.json(
        await this.messaging.page(c.get("owner"), c.req.param("id"), {
          before: number(c.req.query("before")),
          limit: number(c.req.query("limit")),
        }),
      ),
    );
    app.get("/v1/channels/:id/since", async (c) =>
      c.json(
        await this.messaging.since(
          c.get("owner"),
          c.req.param("id"),
          number(c.req.query("seq")) ?? 0,
        ),
      ),
    );
    app.post("/v1/channels/:id/messages", async (c) =>
      c.json(await this.messaging.post(c.get("owner"), c.req.param("id"), await body(c)), 201),
    );
    app.get("/v1/channels/:id/threads", async (c) =>
      c.json(await this.messaging.threads(c.get("owner"), c.req.param("id"))),
    );
    app.get("/v1/messages/:id/replies", async (c) =>
      c.json(
        await this.messaging.replies(c.get("owner"), c.req.param("id"), {
          after: number(c.req.query("after")),
          limit: number(c.req.query("limit")),
        }),
      ),
    );
    app.patch("/v1/messages/:id", async (c) =>
      c.json(await this.messaging.edit(c.get("owner"), c.req.param("id"), await body(c))),
    );
    app.delete("/v1/messages/:id", async (c) =>
      c.json(await this.messaging.remove(c.get("owner"), c.req.param("id"))),
    );
    app.put("/v1/messages/:id/reactions/:emoji", async (c) =>
      c.json(
        await this.messaging.react(
          c.get("owner"),
          c.req.param("id"),
          decodeURIComponent(c.req.param("emoji")),
          true,
        ),
      ),
    );
    app.delete("/v1/messages/:id/reactions/:emoji", async (c) =>
      c.json(
        await this.messaging.react(
          c.get("owner"),
          c.req.param("id"),
          decodeURIComponent(c.req.param("emoji")),
          false,
        ),
      ),
    );

    // Files
    app.post("/v1/files/uploads", async (c) =>
      c.json(
        await this.filing.begin(c.get("owner"), c.get("identity").workspaceId ?? "", await body(c)),
        201,
      ),
    );
    app.post("/v1/files/:id/link", async (c) => {
      const { variant } = z
        .object({ variant: z.enum(["file", "thumb"]).optional() })
        .parse(await body(c));
      return c.json(
        await this.filing.link(
          c.get("owner"),
          c.get("identity").workspaceId ?? "",
          c.req.param("id"),
          variant ?? "file",
        ),
      );
    });
    app.delete("/v1/files/:id", async (c) =>
      c.json(await this.filing.remove(c.get("owner"), c.req.param("id"))),
    );
    app.get("/v1/channels/:id/files", async (c) =>
      c.json(
        (await this.filing.inChannel(c.get("owner"), c.req.param("id"))).map((f) => ({
          id: f.id,
          name: f.name,
          mime: f.mime,
          bytes: f.bytes,
          thumb: f.thumbReady,
          messageId: f.messageId,
          createdAt: f.createdAt,
        })),
      ),
    );
    app.get("/v1/usage", async (c) => c.json(this.files.usage()));

    // What a person is told
    app.get("/v1/notifications", async (c) => {
      const unreadOnly = c.req.query("unread") === "1";
      // What was said to a person in chat, and what the agent told them of its work, together, newest first.
      const notices = [
        ...(await this.messaging.notices(c.get("owner"), { unreadOnly })),
        ...(await this.workNotices.list(c.get("owner"), { unreadOnly })),
      ];
      return c.json(notices.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    const noticeAction =
      (action: "read" | "unread" | "dismiss") =>
      async (c: {
        get(key: "owner"): string;
        req: { param(name: string): string };
        json(value: unknown): Response;
      }) =>
        c.json({
          changed:
            this.messaging.noticeState(c.get("owner"), action, [c.req.param("id")]) +
            this.workNotices.state(c.get("owner"), action, [c.req.param("id")]),
        });
    app.post("/v1/notifications/read-all", async (c) =>
      c.json({
        changed:
          this.messaging.noticeState(c.get("owner"), "read") +
          this.workNotices.state(c.get("owner"), "read"),
      }),
    );
    app.post("/v1/notifications/dismiss-all", async (c) =>
      c.json({
        changed:
          this.messaging.noticeState(c.get("owner"), "dismiss") +
          this.workNotices.state(c.get("owner"), "dismiss"),
      }),
    );
    app.post("/v1/notifications/:id/read", noticeAction("read"));
    app.post("/v1/notifications/:id/unread", noticeAction("unread"));
    app.post("/v1/notifications/:id/dismiss", noticeAction("dismiss"));

    // The agent's runs
    const asker = async (owner: string) => {
      const person = await this.access.person(owner);
      if (!person) throw new AppError("Run not found", 404);
      return person;
    };
    app.post("/v1/runs/:id/stop", async (c) =>
      c.json(await this.agent.stop(await asker(c.get("owner")), c.req.param("id"))),
    );
    app.post("/v1/runs/:id/answer", async (c) => {
      const input = z
        .object({ promptId: z.string().min(1).max(100), choice: choiceSchema })
        .parse(await body(c));
      return c.json(
        await this.agent.answer(
          await asker(c.get("owner")),
          c.req.param("id"),
          input.promptId,
          input.choice,
        ),
      );
    });

    // Owners and admins: what the agent was seen to open of the machine's own data. For anyone else it is not there.
    const watcher = async (owner: string) => {
      if (!(await this.access.manages(owner))) throw new AppError("Not found", 404);
    };
    app.get("/v1/agent-flags", async (c) => {
      await watcher(c.get("owner"));
      const people = await this.access.byId();
      const channels = new Map(
        (await this.store.list<Channel>(SHARED_OWNER, "channels")).map((ch) => [ch.id, ch.name]),
      );
      return c.json({
        mode: await this.agent.watchMode(),
        unreviewed: this.flags.unreviewed(),
        flags: this.flags.list().map((flag) => ({
          ...flag,
          ...(flag.askerId
            ? { askerName: people.get(flag.askerId)?.name || people.get(flag.askerId)?.email }
            : {}),
          ...(flag.channelId ? { channelName: channels.get(flag.channelId) } : {}),
        })),
      });
    });
    // Only the owner changes what is done about it.
    app.put("/v1/agent-watch", async (c) => {
      const person = await this.access.person(c.get("owner"));
      if (person?.role !== "owner") throw new AppError("Not found", 404);
      const { mode } = z.object({ mode: z.enum(WATCH_MODES) }).parse(await body(c));
      await this.agent.setWatchMode(mode);
      return c.json({ mode });
    });
    app.post("/v1/agent-flags/review", async (c) => {
      await watcher(c.get("owner"));
      return c.json({ changed: this.flags.review(c.get("owner")) });
    });
    app.post("/v1/agent-flags/:id/review", async (c) => {
      await watcher(c.get("owner"));
      return c.json({ changed: this.flags.review(c.get("owner"), c.req.param("id")) });
    });

    // Owners and admins: what channels exist, private ones too, and not what is said in them.
    app.get("/v1/admin/channels", async (c) => c.json(await this.people.directory(c.get("owner"))));
    app.post("/v1/admin/channels/:id/join", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      const result = await this.people.enter(c.get("owner"), id);
      await this.announceChange(id, before);
      return c.json(result);
    });
    app.post("/v1/admin/channels/:id/archive", async (c) => {
      const id = c.req.param("id");
      const before = await this.audience(id);
      await this.channels.archive(c.get("owner"), id);
      await this.announceChange(id, before);
      return c.json((await this.people.directory(c.get("owner"))).find((e) => e.id === id));
    });

    // Direct messages
    app.get("/v1/dms/people", async (c) => c.json(await this.dms.people(c.get("owner"))));
    app.post("/v1/dms", async (c) => {
      const owner = c.get("owner");
      const { email } = (await body(c)) as { email?: unknown };
      const channel = await this.dms.open(owner, email);
      this.announce("channel.new", channel.id);
      return c.json(await this.channels.get(owner, channel.id), 201);
    });

    // What a person wants to be told about
    app.get("/v1/notification-prefs", async (c) =>
      c.json(await this.channels.notificationPrefs(c.get("owner"))),
    );
    app.put("/v1/notification-prefs", async (c) =>
      c.json(await this.channels.setNotificationPrefs(c.get("owner"), await body(c))),
    );

    app.notFound((c) => c.json({ error: "Not found" }, 404));
    return app;
  }
}
