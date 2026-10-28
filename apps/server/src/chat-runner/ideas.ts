import { SHARED_OWNER } from "../../../../packages/chat-core/src/shared.ts";
import type { RecordStore } from "../../../../packages/chat-core/src/store.ts";
import {
  type Idea,
  type IdeaBatch,
  ideaBatchSchema,
} from "../../../../packages/domain/src/agent.ts";
import type { RunnerFrame } from "../../../../packages/domain/src/chat-agent.ts";

interface Pending {
  id: string;
  batch: IdeaBatch;
  legacyIds?: string[];
}

/** Only undelivered batches live here. The room owns ideas and their decisions. New mail reports
 * coalesce while disconnected; old machine records are removed only after the room acknowledges them. */
export class IdeaDelivery {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly db: Pick<RecordStore, "list" | "put" | "remove">,
    private readonly send: (frame: RunnerFrame) => boolean,
  ) {}

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }

  report(input: Omit<IdeaBatch, "id">): Promise<void> {
    return this.serial(async () => {
      const batch = ideaBatchSchema.parse({ ...input, id: crypto.randomUUID() });
      await this.db.put("system", "idea-delivery", { id: "mail", batch });
      await this.sendPending();
    });
  }

  onOpen(): Promise<void> {
    return this.serial(async () => {
      const pending = await this.db.list<Pending>("system", "idea-delivery");
      const queued = new Set(pending.flatMap((p) => p.legacyIds ?? []));
      const legacy = (await this.db.list<Idea>(SHARED_OWNER, "ideas")).filter(
        (idea) => !queued.has(idea.id),
      );
      for (let i = 0; i < legacy.length; i += 10) {
        const ideas = legacy.slice(i, i + 10);
        const id = crypto.randomUUID();
        const batch = ideaBatchSchema.parse({ id, ideas, sentMessageIds: [] });
        await this.db.put("system", "idea-delivery", {
          id,
          batch,
          legacyIds: ideas.map((idea) => idea.id),
        });
      }
      await this.sendPending();
    });
  }

  private async sendPending() {
    const queued = await this.db.list<Pending>("system", "idea-delivery");
    // Import old audiences and decisions before a fresh report with the same source id can arrive.
    queued.sort((a, b) => Number(Boolean(b.legacyIds)) - Number(Boolean(a.legacyIds)));
    for (const pending of queued) if (!this.send({ t: "ideas.batch", batch: pending.batch })) break;
  }

  ack(id: string): Promise<void> {
    return this.serial(async () => {
      for (const pending of await this.db.list<Pending>("system", "idea-delivery")) {
        if (pending.batch.id !== id) continue;
        for (const legacyId of pending.legacyIds ?? [])
          await this.db.remove(SHARED_OWNER, "ideas", legacyId);
        await this.db.remove("system", "idea-delivery", pending.id);
      }
    });
  }
}
