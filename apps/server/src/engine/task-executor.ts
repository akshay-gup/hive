import "../config.ts";
import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import { emailDraftSchema, eventDraftSchema } from "../../../../packages/domain/src/index.ts";
import { runOpencodeTask } from "../opencode/tasks.ts";
import type { AgentService } from "./service.ts";
import { conversationTools } from "./tools.ts";
import type { TaskContext } from "./worker.ts";

/**
 * The conversation tools a task run keeps. The worker's own tools win a name they share, and a task
 * cannot wait for a person in the chat the way a conversation can: it asks with ask_user and is
 * paused, so it is not offered request_upload.
 */
export function sharedTaskTools<T extends { name: string }>(
  shared: readonly T[],
  workerTools: readonly { name: string }[],
): T[] {
  return shared.filter(
    (tool) => tool.name !== "request_upload" && !workerTools.some((own) => own.name === tool.name),
  );
}

/** Runs an open-ended task as an OpenCode session, with Hive's tools to hand its outcome back. */
export async function executeTask(
  service: AgentService,
  owner: string,
  initial: AgentTask,
  ctx: TaskContext,
): Promise<Partial<AgentTask>> {
  const config = service.config;
  if (!config.model)
    return {
      status: "waiting_input",
      question:
        "A model is required for this open-ended task. Set MODEL (provider/model-id) on the server, with the provider’s key where `opencode serve` runs, then reply ‘continue’. The document, monitor and finance workflows can run without a model.",
    };
  const runtime = service.opencodeRuntime;
  if (!runtime) throw new Error("OpenCode is not connected, so this task cannot run");
  let task = initial;
  let outcome: Partial<AgentTask> | undefined;
  const operations =
    task.state.operations && typeof task.state.operations === "object"
      ? (task.state.operations as Record<string, unknown>)
      : {};
  const checkpoint = async () => {
    task = await ctx.checkpoint({ state: { ...task.state, operations } });
  };
  // Providers can request parallel tools; durable task checkpoints must stay ordered.
  let toolQueue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = toolQueue.then(operation);
    // Preserve the error on result while allowing the queue to drain after a failed tool.
    toolQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    parameters: T,
    execute: (args: z.output<T>) => Promise<unknown>,
  ) =>
    defineTool({
      name,
      description,
      parameters,
      execute: (args) =>
        serial(async () => {
          if (outcome)
            return {
              paused: true,
              status: outcome.status,
              reason: "The task is waiting or finished; do not perform more actions.",
            };
          await ctx.guard();
          await ctx.event("step", description);
          try {
            return await execute(parameters.parse(args));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Tool failed";
            await ctx.event("error", `${name} failed`, message);
            return { error: message };
          }
        }),
    });
  const cached = async (name: string, args: unknown, operation: () => Promise<unknown>) => {
    const key = createHash("sha256")
      .update(`${name}:${JSON.stringify(args)}`)
      .digest("hex");
    if (key in operations) return operations[key];
    await ctx.guard();
    const result = await operation();
    operations[key] = result;
    await checkpoint();
    return result;
  };
  const tools = [
    tool(
      "read_workspace",
      "Read the authorized workspace sources",
      z.object({ section: z.enum(["mail", "calendar", "files", "all"]) }),
      async ({ section }) => {
        const w = await service.workspace.snapshot(owner);
        return {
          mail: section === "mail" || section === "all" ? w.mail : undefined,
          events: section === "calendar" || section === "all" ? w.events : undefined,
          files:
            section === "files" || section === "all"
              ? w.files.map(({ url, ...file }) => file)
              : undefined,
        };
      },
    ),
    tool(
      "read_mail_thread",
      "Read the complete selected email thread",
      z.object({ threadId: z.string() }),
      async ({ threadId }) => {
        const mail = await service.workspace.thread(owner, threadId);
        task = await ctx.checkpoint({
          evidence: [...task.evidence, ...mail.map((m) => service.mailEvidence(m))],
        });
        return mail;
      },
    ),
    tool(
      "import_pdf",
      "Import a selected email PDF attachment",
      z.object({ reference: z.string() }),
      async (args) =>
        cached("import_pdf", args, async () => {
          const file = await service.workspace.importAttachment(owner, args.reference);
          return { id: file.id, name: file.name, fields: file.fields };
        }),
    ),
    tool(
      "inspect_pdf",
      "Inspect the supported fields of a PDF",
      z.object({ fileId: z.string() }),
      async ({ fileId }) => {
        const file = await service.files.get(owner, fileId);
        return { id: file.id, name: file.name, fields: file.fields, pageCount: file.pageCount };
      },
    ),
    tool(
      "fill_pdf",
      "Save a new PDF using only values supplied by the user",
      z.object({
        fileId: z.string(),
        fields: z.record(z.string(), z.union([z.string(), z.boolean()])),
      }),
      async (args) =>
        cached("fill_pdf", args, async () => {
          const file = await service.files.fill(owner, args.fileId, args.fields);
          task = await ctx.checkpoint({ artifactIds: [...task.artifactIds, file.id] });
          return { id: file.id, name: file.name, fields: file.fields };
        }),
    ),
    tool(
      "read_web",
      "Read a public webpage in the agent browser",
      z.object({ url: z.url() }),
      async ({ url }) => {
        const page = await service.browser.observe(
          owner,
          url,
          typeof task.state.browserId === "string" ? task.state.browserId : undefined,
        );
        task = await ctx.checkpoint({
          state: { ...task.state, browserId: page.sessionId },
          evidence: [
            ...task.evidence,
            {
              id: randomUUID(),
              kind: "web",
              title: page.title,
              url: page.url,
              excerpt: page.text.slice(0, 500),
            },
          ],
        });
        return { ...page, text: page.text.slice(0, 30000) };
      },
    ),
    tool(
      "save_artifact",
      "Save a persistent plan, comparison or report",
      z.object({
        kind: z.enum(["plan", "comparison", "report"]),
        title: z.string().max(160),
        summary: z.string().max(4000),
        data: z.record(z.string(), z.unknown()),
      }),
      async (args) => {
        const artifact = await service.artifact(
          owner,
          task,
          args.kind,
          args.title,
          args.summary,
          args.data,
          args.title,
        );
        task = await ctx.checkpoint({
          artifactIds: [...new Set([...task.artifactIds, artifact.id])],
        });
        return artifact;
      },
    ),
    tool(
      "prepare_email",
      "Prepare the exact email for a separate user review",
      emailDraftSchema,
      async (data) => {
        const key = createHash("sha256").update(JSON.stringify(data)).digest("hex");
        const action = await service.prepare(owner, task, { kind: "email.send", data }, key, ctx);
        if (action.status === "succeeded") {
          task = await ctx.checkpoint({
            state: { ...task.state, approvalResult: action.result },
            actionId: null,
          });
          return { status: "succeeded", actionId: action.id, result: action.result };
        }
        outcome = { status: "waiting_approval", actionId: action.id };
        return { status: "waiting_approval", actionId: action.id };
      },
    ),
    tool(
      "prepare_event",
      "Prepare an event for a separate user review",
      eventDraftSchema,
      async (data) => {
        const key = createHash("sha256").update(JSON.stringify(data)).digest("hex");
        const action = await service.prepare(
          owner,
          task,
          { kind: "calendar.create", data },
          key,
          ctx,
        );
        if (action.status === "succeeded") {
          task = await ctx.checkpoint({
            state: { ...task.state, approvalResult: action.result },
            actionId: null,
          });
          return { status: "succeeded", actionId: action.id, result: action.result };
        }
        outcome = { status: "waiting_approval", actionId: action.id };
        return { status: "waiting_approval", actionId: action.id };
      },
    ),
    tool(
      "ask_user",
      "Pause for a fact, decision or file that is missing. The person answers, and can attach files to the task: they are listed in your brief, and copied into the workspace's attachments folder, when you continue",
      z.object({ question: z.string().min(1).max(2000) }),
      async ({ question }) => {
        outcome = { status: "waiting_input", question };
        return { paused: true, question };
      },
    ),
    tool(
      "finish_task",
      "Hand the finished work to the person for review, only when the requested outcome is actually achieved. They decide whether it is done: they mark it done or send it back with notes",
      z.object({ summary: z.string().min(1).max(8000) }),
      async ({ summary }) => {
        const artifact = await service.artifact(
          owner,
          task,
          "report",
          task.title,
          summary,
          { evidence: task.evidence },
          "final",
        );
        task = await ctx.checkpoint({
          artifactIds: [...new Set([...task.artifactIds, artifact.id])],
        });
        outcome = await service.submitForReview(task, ctx, summary);
        return {
          handedIn: true,
          note: "A person will review it and mark it done or send it back.",
        };
      },
    ),
  ];
  // Tasks run as unattended OpenCode sessions in the channel's workspace directory: they get
  // allow-all rules, because there is nobody to ask, and Hive's own tools, which are what hand
  // the outcome back.
  const shared = conversationTools(
    service,
    owner,
    {
      threadId: task.threadId ?? `task:${task.id}`,
      runId: task.id,
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    {
      signal: ctx.signal,
      requestKey: `task:${task.id}`,
      channelId: task.originChannelId ?? task.channelId,
    },
  );
  const merged = [
    ...sharedTaskTools(shared, tools).map((t) => ({
      ...t,
      execute: (args: unknown) =>
        serial(async () => {
          if (outcome) return { paused: true, status: outcome.status };
          await ctx.guard();
          return (t.execute as (args: unknown) => Promise<unknown>)(args);
        }),
    })),
    ...tools,
  ];
  const result = await runOpencodeTask(
    runtime,
    service,
    owner,
    initial,
    {
      ...ctx,
      checkpoint: async (patch) => {
        task = await ctx.checkpoint(patch);
        return task;
      },
    },
    merged,
    { task: () => task, outcome: () => outcome },
  );
  return outcome ?? result;
}
