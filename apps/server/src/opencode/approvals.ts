/**
 * Pending permission request tracking and replies.
 *
 * `permission.asked` events arrive on the global event bus; the AG-UI shim
 * records them here (and forwards a CUSTOM event to the client). Replies go
 * back through the SDK (`session.permission.reply`) serialized on the
 * scope's action queue so a reply never races prompt dispatch.
 *
 * The agent's own questions are kept the same way (`question.asked`, answered through the SDK's
 * `question.reply`), since a question is a wait just like a permission.
 *
 * Scopes are thread ids for interactive chat and `task:<taskId>` for
 * background task-worker sessions. On run abort / thread dispose, all
 * pending requests for the scope are rejected — OpenCode hangs otherwise.
 */
import type { OpencodeClientPool } from "./client.ts";
import type { OpencodeEventBus } from "./events.ts";

export type PermissionReply = "once" | "always" | "reject";

export interface PendingPermissionRequest {
  requestId: string;
  sessionId: string;
  /** Thread id, or `task:<taskId>` for background task sessions. */
  scope: string;
  threadId?: string;
  taskId?: string;
  channelId: string;
  /** Channel workspace dir — the session's cwd, captured at ask time so a
   * reply never needs to re-resolve the thread binding. */
  directory: string;
  permission: string;
  patterns: string[];
  tool?: { messageID: string; callID: string };
  askedAt: number;
}

export interface AskedPermissionProps {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  tool?: { messageID: string; callID: string };
  /** What OpenCode adds to the ask (for a shell command, what it will run). */
  metadata?: unknown;
}

/** One thing the agent asks the person, as its question tool words it. */
export interface AskedQuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  /** More than one option may be picked. */
  multiple?: boolean;
  /** The person may write an answer of their own (the agent's default is that they may). */
  custom?: boolean;
}

export interface AskedQuestionProps {
  id: string;
  sessionID: string;
  questions: AskedQuestionInfo[];
  tool?: { messageID: string; callID: string };
}

/** A question the agent is waiting on: the same wait as a permission, answered with words. */
export interface PendingQuestion {
  requestId: string;
  sessionId: string;
  scope: string;
  threadId?: string;
  channelId: string;
  directory: string;
  questions: AskedQuestionInfo[];
  askedAt: number;
}

export interface TrackerReplyDeps {
  bus: OpencodeEventBus;
  pool: OpencodeClientPool;
}

export class PermissionTracker {
  private readonly pending = new Map<string, PendingPermissionRequest>();
  private readonly questions = new Map<string, PendingQuestion>();

  /** Record a `permission.asked` event. Idempotent on request id. */
  record(
    scope: {
      scope: string;
      threadId?: string;
      taskId?: string;
      channelId: string;
      directory: string;
    },
    props: AskedPermissionProps,
  ): PendingPermissionRequest {
    const existing = this.pending.get(props.id);
    if (existing) return existing;
    const request: PendingPermissionRequest = {
      requestId: props.id,
      sessionId: props.sessionID,
      scope: scope.scope,
      threadId: scope.threadId,
      taskId: scope.taskId,
      channelId: scope.channelId,
      directory: scope.directory,
      permission: props.permission,
      patterns: props.patterns ?? [],
      tool: props.tool,
      askedAt: Date.now(),
    };
    this.pending.set(props.id, request);
    return request;
  }

  get(requestId: string): PendingPermissionRequest | undefined {
    return this.pending.get(requestId);
  }

  pendingForScope(scope: string): PendingPermissionRequest[] {
    return [...this.pending.values()]
      .filter((request) => request.scope === scope)
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  pendingForThread(threadId: string): PendingPermissionRequest[] {
    return this.pendingForScope(threadId);
  }

  remove(requestId: string): boolean {
    return this.pending.delete(requestId);
  }

  /**
   * Reply to a pending request (`once` / `always` / `reject`), serialized
   * with the scope's other actions. The request leaves the pending set
   * once the server accepts the reply.
   */
  async reply(
    deps: TrackerReplyDeps,
    requestId: string,
    reply: PermissionReply,
    /** What the agent is told when it is turned down. */
    message?: string,
  ): Promise<PendingPermissionRequest> {
    const request = this.pending.get(requestId);
    if (!request) throw new Error(`Permission request ${requestId} is not pending`);
    await deps.bus.enqueue(request.scope, () =>
      deps.pool
        .forDirectory(request.directory)
        .permission.reply({
          requestID: requestId,
          directory: request.directory,
          reply,
          ...(message ? { message } : {}),
        })
        .then((result: { error?: unknown }) => {
          if (result.error)
            throw new Error(
              `permission.reply failed: ${JSON.stringify(result.error).slice(0, 200)}`,
            );
        }),
    );
    this.pending.delete(requestId);
    return request;
  }

  /** Record a `question.asked` event. Idempotent on request id. */
  recordQuestion(
    scope: { scope: string; threadId?: string; channelId: string; directory: string },
    props: AskedQuestionProps,
  ): PendingQuestion {
    const existing = this.questions.get(props.id);
    if (existing) return existing;
    const request: PendingQuestion = {
      requestId: props.id,
      sessionId: props.sessionID,
      scope: scope.scope,
      threadId: scope.threadId,
      channelId: scope.channelId,
      directory: scope.directory,
      questions: props.questions ?? [],
      askedAt: Date.now(),
    };
    this.questions.set(props.id, request);
    return request;
  }

  getQuestion(requestId: string): PendingQuestion | undefined {
    return this.questions.get(requestId);
  }

  questionsForThread(threadId: string): PendingQuestion[] {
    return [...this.questions.values()]
      .filter((request) => request.scope === threadId)
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  removeQuestion(requestId: string): boolean {
    return this.questions.delete(requestId);
  }

  /**
   * Answer a pending question: one list of the chosen answers for each thing asked, or none to
   * turn it down (the agent then goes on without an answer).
   */
  async answerQuestion(
    deps: TrackerReplyDeps,
    requestId: string,
    answers: string[][] | null,
  ): Promise<PendingQuestion> {
    const request = this.questions.get(requestId);
    if (!request) throw new Error(`Question ${requestId} is not pending`);
    await deps.bus.enqueue(request.scope, async () => {
      const client = deps.pool.forDirectory(request.directory);
      const result = answers
        ? await client.question.reply({
            requestID: requestId,
            directory: request.directory,
            answers,
          })
        : await client.question.reject({ requestID: requestId, directory: request.directory });
      if ((result as { error?: unknown }).error)
        throw new Error(`question reply failed: ${JSON.stringify(result.error).slice(0, 200)}`);
    });
    this.questions.delete(requestId);
    return request;
  }

  /**
   * Reject every pending request for a scope, best-effort. Called on run
   * abort and thread dispose: a permission left hanging stalls the session
   * forever. Returns the number of requests rejected.
   */
  async rejectAllForScope(deps: TrackerReplyDeps, scope: string): Promise<number> {
    const requests = this.pendingForScope(scope);
    let rejected = 0;
    for (const request of requests) {
      try {
        await deps.bus.enqueue(request.scope, () =>
          deps.pool
            .forDirectory(request.directory)
            .permission.reply({
              requestID: request.requestId,
              directory: request.directory,
              reply: "reject",
            })
            .catch(() => undefined),
        );
        rejected++;
      } catch {
        // Best effort: the session may already be gone.
      } finally {
        this.pending.delete(request.requestId);
      }
    }
    for (const request of [...this.questions.values()].filter((q) => q.scope === scope)) {
      try {
        await deps.bus.enqueue(request.scope, () =>
          deps.pool
            .forDirectory(request.directory)
            .question.reject({ requestID: request.requestId, directory: request.directory })
            .catch(() => undefined),
        );
        rejected++;
      } catch {
        // Best effort, as above.
      } finally {
        this.questions.delete(request.requestId);
      }
    }
    return rejected;
  }
}
