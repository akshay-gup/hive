import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
} from "../../../../packages/domain/src/agent.ts";
import { AppError } from "../errors.ts";
import { byteRange } from "./channel-files.ts";
import type { AgentService } from "./service.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});

export function agentRoutes(service: AgentService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  app.post("/tasks", async (c) =>
    c.json(await service.createTask(c.get("owner"), await c.req.json()), 201),
  );
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  app.patch("/tasks/:id", async (c) =>
    c.json(await service.updateTask(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/tasks/:id", async (c) =>
    c.json(await service.deleteTask(c.get("owner"), c.req.param("id"))),
  );
  app.post("/projects", async (c) =>
    c.json(await service.createProject(c.get("owner"), await c.req.json()), 201),
  );
  app.patch("/projects/:id", async (c) =>
    c.json(await service.updateProject(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.delete("/projects/:id", async (c) =>
    c.json(await service.deleteProject(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/accept", async (c) =>
    c.json(await service.accept(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/notes", async (c) =>
    c.json(await service.addNote(c.get("owner"), c.req.param("id"), await c.req.json()), 201),
  );
  app.delete("/tasks/:id/notes/:noteId", async (c) =>
    c.json(await service.removeNote(c.get("owner"), c.req.param("id"), c.req.param("noteId"))),
  );
  app.post("/tasks/:id/attachments", async (c) => {
    const file = (await c.req.parseBody()).file;
    if (!(file instanceof File)) throw new AppError("Choose a file to attach");
    return c.json(
      await service.addAttachment(c.get("owner"), c.req.param("id"), {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
      201,
    );
  });
  app.delete("/tasks/:id/attachments/:attachmentId", async (c) =>
    c.json(
      await service.removeAttachment(
        c.get("owner"),
        c.req.param("id"),
        c.req.param("attachmentId"),
      ),
    ),
  );
  /** Signed, like Files, so a browser can open it without the access key. */
  app.get("/tasks/:id/attachments/:attachmentId/content", async (c) => {
    const { file, bytes } = await service.attachmentContent(
      c.get("owner"),
      c.req.param("id"),
      c.req.param("attachmentId"),
    );
    const inline = file.mimeType === "application/pdf" || file.mimeType.startsWith("image/");
    c.header("Content-Type", file.mimeType);
    c.header(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    // Uploaded by a person: never let a browser guess a type or run anything from it. (A sandboxed
    // page cannot open a PDF in the browser's own reader, so PDFs get the type header alone.)
    c.header("X-Content-Type-Options", "nosniff");
    if (file.mimeType !== "application/pdf")
      c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    return c.body(bytes);
  });
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  app.get("/channels", async (c) => c.json(await service.listChannels(c.get("owner"))));
  app.post("/channels", async (c) =>
    c.json(await service.createChannel(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/channels/:id/archive", async (c) =>
    c.json(await service.archiveChannel(c.req.param("id"))),
  );
  app.get("/channels/:id/files", async (c) => {
    const query = z
      .object({
        path: z.string().max(1024).optional(),
        recent: z.enum(["1", "true"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(c.req.query());
    const owner = c.get("owner");
    const id = c.req.param("id");
    return c.json(
      query.recent
        ? await service.channelFiles.recent(owner, id, query.limit)
        : await service.channelFiles.list(owner, id, query.path),
    );
  });
  app.get("/channels/:id/files/info", async (c) => {
    const { path } = z.object({ path: z.string().max(1024) }).parse(c.req.query());
    return c.json(await service.channelFiles.info(c.get("owner"), c.req.param("id"), path));
  });
  app.post("/channels/:id/files", async (c) => {
    const form = await c.req.parseBody();
    if (!(form.file instanceof File)) throw new AppError("Choose a file to add");
    const owner = c.get("owner");
    const id = c.req.param("id");
    // A file added for an agent's request goes where the agent asked, and is recorded against it.
    const request = typeof form.request === "string" && form.request ? form.request : undefined;
    const saved = await service.channelFiles.save(
      owner,
      id,
      request
        ? await service.uploadRequests.folder(owner, id, request)
        : typeof form.dir === "string"
          ? form.dir
          : undefined,
      form.file.name,
      new Uint8Array(await form.file.arrayBuffer()),
    );
    if (request)
      await service.uploadRequests.attach(owner, id, request, {
        path: saved.path,
        name: saved.name,
        size: saved.size,
        kind: saved.kind,
      });
    return c.json(saved, 201);
  });
  app.get("/channels/:id/uploads/:requestId", async (c) =>
    c.json(
      await service.uploadRequests.get(c.get("owner"), c.req.param("id"), c.req.param("requestId")),
    ),
  );
  /**
   * A file's bytes, for a link made by `channelFiles.info` or `.list`. The token in the path is the
   * credential (and says what the link covers), so a page's relative links to the files beside it
   * work. Served so a browser never runs what an agent or a person put there as part of Hive.
   */
  app.get("/channels/:id/view/:token/*", async (c) => {
    const token = c.req.param("token");
    const marker = `/view/${token}/`;
    const pathname = new URL(c.req.url).pathname;
    let path: string;
    try {
      path = pathname
        .slice(pathname.indexOf(marker) + marker.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
    } catch {
      throw new AppError("That path is not valid");
    }
    const { file, real } = await service.channelFiles.byLink(token, c.req.param("id"), path);
    const range = byteRange(c.req.header("range"), file.size);
    if (range === "unsatisfiable")
      return c.body(null, 416, { "Content-Range": `bytes */${file.size}` });
    const mimeType = file.mimeType ?? "application/octet-stream";
    const text = mimeType.startsWith("text/") || mimeType === "application/json";
    const inline =
      c.req.query("download") !== "1" && !["archive", "other"].includes(file.kind ?? "other");
    c.header("Content-Type", text ? `${mimeType}; charset=utf-8` : mimeType);
    c.header(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    c.header("Accept-Ranges", "bytes");
    c.header("X-Content-Type-Options", "nosniff");
    // What a person or an agent put here is not Hive's to run: no script reaches Hive's own page
    // or storage. A web page may run its own scripts, in a sandbox of its own. (A sandboxed page
    // cannot open a PDF in the browser's reader, so PDFs get no policy.)
    if (file.kind === "html")
      c.header(
        "Content-Security-Policy",
        "sandbox allow-scripts allow-forms allow-popups allow-modals",
      );
    else if (file.kind !== "pdf") c.header("Content-Security-Policy", "sandbox");
    // `?head=N` is for a viewer that only shows the start of a file, so a big log costs little.
    const head = Number(c.req.query("head"));
    const first = range?.start ?? 0;
    const last = Math.min(
      range?.end ?? file.size - 1,
      Number.isSafeInteger(head) && head > 0 ? first + head - 1 : Number.POSITIVE_INFINITY,
    );
    c.header("Content-Length", String(file.size ? last - first + 1 : 0));
    if (range) c.header("Content-Range", `bytes ${first}-${last}/${file.size}`);
    if (!file.size) return c.body(null, 200);
    return c.body(
      Readable.toWeb(createReadStream(real, { start: first, end: last })) as ReadableStream,
      range ? 206 : 200,
    );
  });
  app.get("/channels/:id/tasks", async (c) =>
    c.json(await service.channelTasks(c.get("owner"), c.req.param("id"))),
  );
  app.post("/channels/:id/threads", async (c) => {
    const raw = await c.req.text();
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        parentMessageId: z.string().trim().min(1).max(120).optional(),
      })
      .parse(raw ? JSON.parse(raw) : {});
    return c.json(
      await service.registerThread(
        c.get("owner"),
        c.req.param("id"),
        body.name,
        body.parentMessageId,
      ),
      201,
    );
  });
  app.get("/channels/:id/threads", async (c) =>
    c.json(await service.listChannelThreads(c.get("owner"), c.req.param("id"))),
  );
  app.post("/threads/bind", async (c) => {
    const body = z
      .object({
        threadId: z.string().trim().min(1).max(120),
        channelId: z.string().trim().min(1).max(80),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.ensureThreadBinding(c.get("owner"), body.threadId, body.channelId, body.name),
    );
  });
  app.patch("/threads/:threadId", async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    return c.json(await service.renameThread(c.get("owner"), c.req.param("threadId"), body.name));
  });
  app.get("/threads/:threadId/channel", async (c) => {
    const binding = await service.channelOfThread(c.get("owner"), c.req.param("threadId"));
    if (!binding) throw new AppError("Thread is not bound to a channel", 404);
    return c.json(binding);
  });
  app.get("/threads/:threadId/tasks", async (c) =>
    c.json(await service.threadTasks(c.get("owner"), c.req.param("threadId"))),
  );
  app.post("/tasks/:id/delegate", async (c) => {
    const body = z
      .object({
        target: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(1).max(500).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.delegateTask(c.get("owner"), c.req.param("id"), body.target, body.reason),
    );
  });
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory: AgentMemory = {
      id: randomUUID(),
      text: body.text,
      source: body.source ?? "You",
      createdAt: new Date().toISOString(),
    };
    return c.json(await service.db.put(c.get("owner"), "memories", memory), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    if (!(await service.db.take(c.get("owner"), "memories", c.req.param("id"))))
      throw new AppError("Memory not found", 404);
    return c.json({ ok: true });
  });
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        tone: z.enum(["warm", "concise", "thoughtful"]),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      body,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/notifications", async (c) =>
    c.json((await service.snapshot(c.get("owner"))).notifications),
  );
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  // Notifications belong to the workspace, as reading one does: dismissing removes it for everyone.
  app.post("/notifications/dismiss-all", async (c) => {
    const owner = c.get("owner");
    const all = await service.db.list<AgentNotification>(owner, "notifications");
    for (const notification of all)
      await service.db.remove(owner, "notifications", notification.id);
    return c.json({ removed: all.length });
  });
  app.post("/notifications/:id/dismiss", async (c) => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    if (!(await service.db.get<AgentNotification>(owner, "notifications", id)))
      throw new AppError("Notification not found", 404);
    await service.db.remove(owner, "notifications", id);
    return c.json({ ok: true });
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  return app;
}
