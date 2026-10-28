import type { RecordStore } from "../../../../packages/chat-core/src/store.ts";
import type { RunnerFrame } from "../../../../packages/domain/src/chat-agent.ts";

/**
 * A source failure awaiting delivery to the room, not a notification store. The room alone chooses who
 * hears it and keeps their read/dismiss state. Unacknowledged reports survive a connection or machine restart.
 */
export class SourceErrors {
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Pick<RecordStore, "put" | "list" | "remove">,
    private readonly send: (frame: RunnerFrame) => boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  async report(): Promise<void> {
    const at = Math.floor(this.clock() / 3_600_000) * 3_600_000;
    await this.db.put("system", "source-errors", { id: String(at), at });
    await this.flush();
  }

  flush(): Promise<void> {
    const next = this.sending.then(() => this.sendPending());
    // A failed attempt does not prevent the next connection from trying again.
    this.sending = next.catch(() => undefined);
    return next;
  }

  private async sendPending() {
    const pending = await this.db.list<{ id: string; at: number }>("system", "source-errors");
    for (const report of pending) {
      if (report.at < this.clock() - 7 * 24 * 60 * 60_000) {
        await this.ack(report.at);
        continue;
      }
      if (!this.send({ t: "source.error", at: report.at })) break;
    }
  }

  async ack(at: number): Promise<void> {
    await this.db.remove("system", "source-errors", String(at));
  }
}
