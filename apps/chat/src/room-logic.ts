import { z } from "zod";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import { ChatCore, type ChatIdentity } from "./core.ts";
import { IDENTITY_HEADER, INTERNAL_HEADER } from "./headers.ts";
import { type Peer, Realtime } from "./realtime.ts";

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
      /** Who is connected right now. */
      peers?: () => Peer[];
      /** Keep the room running until this is done, which a response ending would otherwise cut short. */
      keepAlive?: (work: Promise<unknown>) => void;
    },
  ) {
    this.core = new ChatCore(sql, {
      clock: hooks.clock,
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
    const gone = this.sql.all<{ before: number }>(
      "SELECT before FROM revoked WHERE user_id = ?",
      identity.sub,
    )[0];
    if (gone && identity.issuedAt < gone.before)
      return Response.json({ error: "This sign-in has ended. Sign in again." }, { status: 401 });
    return identity;
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
      return Response.json({ ok: true });
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
