import { Hono } from "hono";
import { z } from "zod";
import {
  Access,
  isDm,
  managesChannel,
  type Person,
} from "../../../packages/chat-core/src/access.ts";
import { ChannelPeople } from "../../../packages/chat-core/src/channel-people.ts";
import { ChatChannels } from "../../../packages/chat-core/src/channels.ts";
import { DirectMessages } from "../../../packages/chat-core/src/direct-messages.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import { type ChatEvent, Events } from "../../../packages/chat-core/src/events.ts";
import { Files } from "../../../packages/chat-core/src/files.ts";
import { Messages } from "../../../packages/chat-core/src/messages.ts";
import { Notifications } from "../../../packages/chat-core/src/notifications.ts";
import { Reactions } from "../../../packages/chat-core/src/reactions.ts";
import { Reads } from "../../../packages/chat-core/src/reads.ts";
import { migrate } from "../../../packages/chat-core/src/schema.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import { SqliteRecordStore } from "../../../packages/chat-core/src/sqlite-store.ts";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import type { WorkspaceRole } from "../../../packages/integrations/src/workspace-token.ts";
import { Filing } from "./filing.ts";
import { Messaging } from "./messaging.ts";

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
    this.workQueued();
    return { ok: true };
  }

  /** The ids of the people who may open a channel now; none for one that does not exist. */
  private async audience(channelId: string): Promise<Set<string>> {
    const channel = await this.store.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel) return new Set();
    return new Set((await this.access.openers(channel)).map((who) => who.owner));
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
      if (error instanceof z.ZodError)
        return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
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
    app.get("/v1/notifications", async (c) =>
      c.json(
        await this.messaging.notices(c.get("owner"), { unreadOnly: c.req.query("unread") === "1" }),
      ),
    );
    const noticeAction =
      (action: "read" | "unread" | "dismiss") =>
      async (c: {
        get(key: "owner"): string;
        req: { param(name: string): string };
        json(value: unknown): Response;
      }) =>
        c.json({
          changed: this.messaging.noticeState(c.get("owner"), action, [c.req.param("id")]),
        });
    app.post("/v1/notifications/read-all", async (c) =>
      c.json({ changed: this.messaging.noticeState(c.get("owner"), "read") }),
    );
    app.post("/v1/notifications/dismiss-all", async (c) =>
      c.json({ changed: this.messaging.noticeState(c.get("owner"), "dismiss") }),
    );
    app.post("/v1/notifications/:id/read", noticeAction("read"));
    app.post("/v1/notifications/:id/unread", noticeAction("unread"));
    app.post("/v1/notifications/:id/dismiss", noticeAction("dismiss"));

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
