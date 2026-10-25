import { Hono } from "hono";
import { z } from "zod";
import { Access, type Person } from "../../../packages/chat-core/src/access.ts";
import { ChannelPeople } from "../../../packages/chat-core/src/channel-people.ts";
import { ChatChannels } from "../../../packages/chat-core/src/channels.ts";
import { DirectMessages } from "../../../packages/chat-core/src/direct-messages.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import { Events } from "../../../packages/chat-core/src/events.ts";
import { Messages } from "../../../packages/chat-core/src/messages.ts";
import { Notifications } from "../../../packages/chat-core/src/notifications.ts";
import { Reactions } from "../../../packages/chat-core/src/reactions.ts";
import { Reads } from "../../../packages/chat-core/src/reads.ts";
import { migrate } from "../../../packages/chat-core/src/schema.ts";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import { SqliteRecordStore } from "../../../packages/chat-core/src/sqlite-store.ts";
import type { WorkspaceRole } from "../../../packages/integrations/src/workspace-token.ts";

/** Who is asking, as the Worker verified it from the control plane's token. */
export interface ChatIdentity {
  sub: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  /** When the token was made, in milliseconds. */
  issuedAt: number;
  limits?: { maxFileBytes: number; storageBytes: number };
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
  readonly app: Hono<{ Bindings: Bindings; Variables: Variables }>;

  constructor(
    readonly sql: Sql,
    options: { now?: () => string; clock?: () => number } = {},
  ) {
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
    app.post("/v1/channels", async (c) =>
      c.json(await this.channels.create(c.get("owner"), await body(c)), 201),
    );
    app.get("/v1/channels/:id", async (c) =>
      c.json(await this.channels.get(c.get("owner"), c.req.param("id"))),
    );
    app.get("/v1/channels/:id/members", async (c) =>
      c.json(await this.people.get(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/channels/:id/members", async (c) =>
      c.json(
        (await this.people.change(c.get("owner"), c.req.param("id"), await body(c))) ?? {
          left: true,
        },
      ),
    );
    app.post("/v1/channels/:id/managers", async (c) =>
      c.json(await this.people.managers(c.get("owner"), c.req.param("id"), await body(c))),
    );
    app.patch("/v1/channels/:id", async (c) =>
      c.json(await this.people.settings(c.get("owner"), c.req.param("id"), await body(c))),
    );
    app.post("/v1/channels/:id/archive", async (c) =>
      c.json(await this.channels.archive(c.get("owner"), c.req.param("id"))),
    );
    app.get("/v1/channels/:id/mentionable", async (c) =>
      c.json(await this.channels.mentionable(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/channels/:id/read", async (c) => {
      const { seq } = z.object({ seq: z.number().int().min(0).optional() }).parse(await body(c));
      const at = await this.channels.markRead(c.get("owner"), c.req.param("id"), seq);
      return c.json({ ok: true, seq: at });
    });

    // Owners and admins: what channels exist, private ones too, and not what is said in them.
    app.get("/v1/admin/channels", async (c) => c.json(await this.people.directory(c.get("owner"))));
    app.post("/v1/admin/channels/:id/join", async (c) =>
      c.json(await this.people.enter(c.get("owner"), c.req.param("id"))),
    );
    app.post("/v1/admin/channels/:id/archive", async (c) => {
      await this.channels.archive(c.get("owner"), c.req.param("id"));
      return c.json(
        (await this.people.directory(c.get("owner"))).find((e) => e.id === c.req.param("id")),
      );
    });

    // Direct messages
    app.get("/v1/dms/people", async (c) => c.json(await this.dms.people(c.get("owner"))));
    app.post("/v1/dms", async (c) => {
      const owner = c.get("owner");
      const { email } = (await body(c)) as { email?: unknown };
      const channel = await this.dms.open(owner, email);
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
