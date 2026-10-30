import { AppError } from "../../../../packages/chat-core/src/errors.ts";
import type { RoomFrame, RunnerFrame, WorkOp } from "../../../../packages/domain/src/chat-agent.ts";

/**
 * What a call on the board is bound to: a chat run that is going, a task the machine holds, or (in the app's
 * own chat with the agent, where the room has no run) a ticket the room gave the app for that person.
 */
export type WorkScope =
  | { runId: string }
  | { taskId: string; leaseId: string }
  | { ticket: string };

/** The board as the agent's tools reach it, for the run, task or person they are working for. */
export interface Board {
  forRun(runId: string): WorkClient;
  forTask(taskId: string): WorkClient;
  forPerson(owner: string): WorkClient;
}

/** The board when the machine is not connected to a chat service: nothing can be changed. */
export const noBoard: Board = (() => {
  const none: WorkClient = {
    call: () => Promise.reject(new AppError("The board is not available here", 503)),
  };
  return { forRun: () => none, forTask: () => none, forPerson: () => none };
})();

/** What the agent's tools use to change the board. The room decides who they act as and what they may do. */
/**
 * Whether a board ticket names the person who is signed in here. The chat service checks the ticket's
 * signature; this checks it was not handed over by someone else, so a session cannot borrow another
 * person's ticket and act as them on the board. (A ticket names the account; here a signed-in person of a
 * managed workspace is `acct:` and the account.)
 */
export function ticketIsFor(ticket: string, owner: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(ticket.split(".")[0] ?? "", "base64url").toString()) as {
      u?: unknown;
    };
    if (typeof claims.u !== "string") return false;
    return owner === (claims.u.startsWith("acct:") ? claims.u : `acct:${claims.u}`);
  } catch {
    return false;
  }
}

export interface WorkClient {
  call<T = unknown>(op: WorkOp, args: Record<string, unknown>, key?: string): Promise<T>;
}

export interface WorkLinkDeps {
  send: (frame: RunnerFrame) => boolean;
  /** What the machine keeps of a task's runs, for the room to hand to a person it has checked. */
  history: (ask: Extract<RoomFrame, { t: "work.ask"; op: "task.history" }>) => Promise<unknown>;
  timeoutMs?: number;
}

/**
 * The board lives in the chat service. The machine asks it to do what the agent's tools do, one request at a
 * time, each bound to a run or a task the room has given it, and gets the answer back. It never asks for the
 * board as a whole: what the agent may see of it, the room says.
 */
export class WorkLink {
  private readonly waiting = new Map<
    string,
    {
      resolve: (body: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly deps: WorkLinkDeps) {}

  /** The board for the agent's tools: a run's, a task's by its current lease, or a person's by their ticket. */
  board(deps: {
    leaseOf: (taskId: string) => string | undefined;
    ticketOf: (owner: string) => string | undefined;
  }): Board {
    const later = (scope: () => WorkScope | AppError): WorkClient => ({
      call: <T>(op: WorkOp, args: Record<string, unknown>, key?: string) => {
        const resolved = scope();
        return resolved instanceof AppError
          ? Promise.reject(resolved)
          : (this.call(resolved, op, args, key) as Promise<T>);
      },
    });
    return {
      forRun: (runId) => this.for({ runId }),
      forTask: (taskId) =>
        later(() => {
          const leaseId = deps.leaseOf(taskId);
          return leaseId
            ? { taskId, leaseId }
            : new AppError("This task is not being worked on", 409);
        }),
      forPerson: (owner) =>
        later(() => {
          const ticket = deps.ticketOf(owner);
          return ticket
            ? { ticket }
            : new AppError("Open the app again to let the agent change the board", 401);
        }),
    };
  }

  /** A client whose calls are bound to a run or a task. */
  for(scope: WorkScope): WorkClient {
    return {
      call: <T>(op: WorkOp, args: Record<string, unknown>, key?: string) =>
        this.call(scope, op, args, key) as Promise<T>,
    };
  }

  private call(
    scope: WorkScope,
    op: WorkOp,
    args: Record<string, unknown>,
    key?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new AppError("The chat service did not answer", 503));
      }, this.deps.timeoutMs ?? 30_000);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiting.set(reqId, { resolve, reject, timer });
      const sent = this.deps.send({
        t: "work.call",
        reqId,
        ...scope,
        op,
        args,
        ...(key ? { key } : {}),
      });
      if (!sent) {
        this.waiting.delete(reqId);
        clearTimeout(timer);
        reject(new AppError("Not connected to the chat service", 503));
      }
    });
  }

  onFrame(frame: RoomFrame) {
    if (frame.t === "work.result") {
      const waiting = this.waiting.get(frame.reqId);
      if (!waiting) return;
      this.waiting.delete(frame.reqId);
      clearTimeout(waiting.timer);
      if (frame.ok) waiting.resolve(frame.body);
      else waiting.reject(new AppError(frame.error, statusOf(frame.status)));
      return;
    }
    if (frame.t === "work.ask") {
      void this.deps
        .history(frame)
        .then((body) => this.deps.send({ t: "work.answer", reqId: frame.reqId, ok: true, body }))
        .catch((error) =>
          this.deps.send({
            t: "work.answer",
            reqId: frame.reqId,
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 500) : "Could not read it",
          }),
        );
    }
  }

  /** The connection dropped: what was asked will not be answered. */
  onClose() {
    for (const [reqId, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new AppError("The chat service went away", 503));
      this.waiting.delete(reqId);
    }
  }
}

const STATUSES = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503] as const;
const statusOf = (status: number): (typeof STATUSES)[number] =>
  (STATUSES as readonly number[]).includes(status) ? (status as (typeof STATUSES)[number]) : 400;
