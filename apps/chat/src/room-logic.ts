import { z } from "zod";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import type { RunnerLink } from "./agent-link.ts";
import { ChatCore, type ChatIdentity } from "./core.ts";
import { IDENTITY_HEADER, INTERNAL_HEADER } from "./headers.ts";
import { type Peer, Realtime } from "./realtime.ts";

const fileCallSchema = z.object({
  fileId: z.string().min(1).max(100),
  variant: z.enum(["file", "thumb"]),
  bytes: z.number().int().min(0).optional(),
});

const peopleSchema = z.object({
  people: z
    .array(
      z.object({
        sub: z.string().min(1).max(200),
        email: z.string().min(1).max(320),
        name: z.string().max(200),
        role: z.enum(["owner", "admin", "member", "guest"]),
      }),
    )
    .max(5000),
});

/**
 * What one workspace's room does with a request, without anything of Cloudflare in it: the
 * Durable Object gives it its SQLite and a way to wipe it, and the tests give it Node's. Everything
 * arrives through the Worker, which has checked the token; the room trusts the headers the Worker
 * sets, and nothing reaches it any other way.
 */
export class RoomLogic {
  readonly core: ChatCore;
  readonly realtime: Realtime;

  constructor(
    private readonly sql: Sql,
    private readonly hooks: {
      purge(): Promise<void>;
      clock?: () => number;
      /** The people connected right now (not the agent's machine). */
      peers?: () => Peer[];
      /** The agent's machine, if it is connected. */
      runner?: () => RunnerLink | null;
      /** Ask for the agent's machine to be started. */
      wake?: () => void;
      /** Keep the room running until this is done, which a response ending would otherwise cut short. */
      keepAlive?: (work: Promise<unknown>) => void;
      /** The key files' addresses are signed with. */
      linkKey?: () => string | undefined;
      /** Delete these objects from the bucket. The bucket is only touched here, never inside a change to the room. */
      deleteObjects?: (keys: string[]) => Promise<void>;
      /** Ask to be woken in this many milliseconds to do the room's upkeep, unless sooner is already asked for. */
      wakeIn?: (ms: number) => void;
    },
  ) {
    this.core = new ChatCore(sql, {
      clock: hooks.clock,
      linkKey: hooks.linkKey,
      workQueued: () => hooks.wakeIn?.(5_000),
      runner: () => hooks.runner?.() ?? null,
      stream: (channelId, message) => hooks.keepAlive?.(this.realtime.stream(channelId, message)),
      workspaceId: () => this.workspaceId(),
      wake: hooks.wake,
      publish: (event) => {
        const sent = this.realtime.publish(event);
        hooks.keepAlive?.(sent);
      },
    });
    this.realtime = new Realtime(this.core, () => hooks.peers?.() ?? [], hooks.clock);
  }

  /** Who is asking, from what the Worker said; or the answer to give a person who is not (or is no longer) signed in. */
  identityOf(request: Request): ChatIdentity | Response {
    const header = request.headers.get(IDENTITY_HEADER);
    if (!header) return Response.json({ error: "Not signed in" }, { status: 401 });
    const identity = JSON.parse(header) as ChatIdentity;
    if (identity.workspaceId) this.rememberWorkspace(identity.workspaceId);
    const gone = this.sql.all<{ before: number }>(
      "SELECT before FROM revoked WHERE user_id = ?",
      identity.sub,
    )[0];
    if (gone && identity.issuedAt < gone.before)
      return Response.json({ error: "This sign-in has ended. Sign in again." }, { status: 401 });
    return identity;
  }

  /** Which workspace this room is, kept so upkeep can name its files in the bucket without anyone asking. */
  private rememberWorkspace(id: string) {
    this.sql.run(
      "INSERT INTO meta (key, value) VALUES ('workspace', ?) ON CONFLICT (key) DO NOTHING",
      id,
    );
  }

  workspaceId(): string | null {
    return (
      this.sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'workspace'")[0]?.value ??
      null
    );
  }

  /**
   * The room's upkeep: uploads that were never finished give their room back, what the bucket is to
   * delete is deleted, old events are let go, and the count of stored bytes is checked against the
   * files. Returns when to do it next.
   */
  async maintain(): Promise<{ nextInMs: number }> {
    const files = this.core.files;
    files.expire();
    const workspace = this.workspaceId();
    for (;;) {
      const keys = files.pendingDeletes(100);
      if (keys.length === 0) break;
      if (!workspace || !this.hooks.deleteObjects) break;
      await this.hooks.deleteObjects(keys.map((key) => `w/${workspace}/${key}`));
      files.deleted(keys);
    }
    this.core.events.prune();
    files.reconcile();
    // Runs that waited, ran or asked too long are ended, and the room looks at them again soon while any are going.
    const running = await this.core.agent.maintain();
    // Soon again while an upload is waiting out its time, otherwise once a day.
    if (running) return { nextInMs: 30_000 };
    return { nextInMs: files.hasWork() ? 60_000 : 24 * 3600_000 };
  }

  async fetch(request: Request): Promise<Response> {
    const internal = request.headers.get(INTERNAL_HEADER);
    if (internal) return this.control(internal, request);
    const identity = this.identityOf(request);
    if (identity instanceof Response) return identity;
    return this.core.handle(request, identity);
  }

  /** What the control plane asks of a room: end someone's access, or clear everything out. */
  private async control(action: string, request: Request): Promise<Response> {
    if (action === "revoke") {
      const { sub } = (await request.json()) as { sub: string };
      // Tokens are stamped to the second, so a token made in the second of the revocation cannot be told from one made before it; both end, and a new one works from the next second.
      const now = (this.hooks.clock ?? Date.now)();
      const before = (Math.floor(now / 1000) + 1) * 1000;
      this.sql.run(
        "INSERT INTO revoked (user_id, before) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET before = MAX(before, excluded.before)",
        sub,
        before,
      );
      await this.core.agent.revoked(sub);
      return Response.json({ ok: true });
    }
    if (action === "file-state" || action === "file-done" || action === "file-download") {
      const { fileId, variant, bytes } = fileCallSchema.parse(await request.json());
      const filing = this.core.filing;
      if (action === "file-state") {
        const state = filing.uploadState(fileId, variant);
        return state ? Response.json(state) : Response.json({ error: "Not open" }, { status: 409 });
      }
      if (action === "file-download") {
        const found = filing.download(fileId, variant);
        return found
          ? Response.json(found)
          : Response.json({ error: "Not found" }, { status: 404 });
      }
      try {
        filing.uploaded(fileId, variant, bytes ?? 0);
        return Response.json({ ok: true });
      } catch (error) {
        if (error instanceof AppError)
          return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    if (action === "people") {
      const { people } = peopleSchema.parse(await request.json());
      await this.core.syncPeople(people);
      return Response.json({ ok: true, count: people.length });
    }
    if (action === "purge") {
      await this.hooks.purge();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
