/**
 * OpenCode permission HTTP API (mounted under /api/agent/opencode).
 *
 * - GET  /threads/:threadId/permissions/pending — pending requests for a thread
 * - POST /permissions/:requestId/reply — { reply: "once" | "always" | "reject" }
 * - GET  /threads/:threadId/questions/pending — questions the agent is waiting on
 * - POST /questions/:requestId/reply — { answers: string[][] } (one list per question), or { dismiss: true }
 * - GET  /channels/:channelId/permissions — channel rule strings
 * - PUT  /channels/:channelId/permissions — { rules: string[] }
 * - GET  /channels/:channelId/permissions/mode — { mode: "ask" | "auto" }
 * - PUT  /channels/:channelId/permissions/mode — { mode: "ask" | "auto" }
 * - GET  /threads/:threadId/permissions/rules — { rules, channelRules }
 * - PUT  /threads/:threadId/permissions/rules — { rules: string[] } (thread override)
 * - GET  /threads/:threadId/permissions/mode — { mode: "ask" | "auto" | null, channelMode }
 * - PUT  /threads/:threadId/permissions/mode — { mode: "ask" | "auto" | null } (null = inherit)
 *
 * Rule strings are opencode-style (`tool:pattern:action`); invalid lines 422.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { OpencodeShimDeps } from "./agui.ts";
import type { PermissionReply } from "./approvals.ts";
import { invalidRuleLines, isPermissionMode } from "./permissions.ts";

const replySchema = z.object({ reply: z.enum(["once", "always", "reject"]) });
const answerSchema = z.union([
  z.object({
    answers: z.array(z.array(z.string().max(2000)).max(50)).max(20),
  }),
  z.object({ dismiss: z.literal(true) }),
]);
const rulesSchema = z.object({ rules: z.array(z.string().max(500)).max(200) });
const modeSchema = z.object({ mode: z.enum(["ask", "auto"]) });
const threadModeSchema = z.object({ mode: z.enum(["ask", "auto"]).nullable() });

function serialize(request: {
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: { messageID: string; callID: string };
  askedAt: number;
  channelId: string;
}) {
  return {
    requestId: request.requestId,
    permission: request.permission,
    patterns: request.patterns,
    tool: request.tool,
    askedAt: request.askedAt,
    channelId: request.channelId,
  };
}

export function opencodePermissionRoutes(deps: OpencodeShimDeps) {
  const app = new Hono<{ Variables: { owner: string } }>();

  app.get("/threads/:threadId/permissions/pending", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    return c.json(deps.tracker.pendingForThread(threadId).map(serialize));
  });

  app.post("/permissions/:requestId/reply", async (c) => {
    const parsed = replySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "reply must be once, always or reject" }, 400);
    const requestId = c.req.param("requestId");
    const pending = deps.tracker.get(requestId);
    if (!pending) return c.json({ error: "Permission request is not pending" }, 404);
    // What a private channel's agent asks to do is for the people in that channel to allow.
    try {
      await deps.service.access.assertChannel(c.get("owner"), pending.channelId);
    } catch {
      return c.json({ error: "Permission request is not pending" }, 404);
    }
    try {
      const answered = await deps.tracker.reply(
        deps,
        requestId,
        parsed.data.reply as PermissionReply,
      );
      return c.json({ ok: true, ...serialize(answered) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Reply failed" }, 502);
    }
  });

  app.get("/threads/:threadId/questions/pending", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    return c.json(
      deps.tracker.questionsForThread(threadId).map((request) => ({
        requestId: request.requestId,
        questions: request.questions,
        askedAt: request.askedAt,
        channelId: request.channelId,
      })),
    );
  });

  app.post("/questions/:requestId/reply", async (c) => {
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Body must be { answers: string[][] } or { dismiss: true }" }, 400);
    const requestId = c.req.param("requestId");
    const pending = deps.tracker.getQuestion(requestId);
    if (!pending) return c.json({ error: "Question is not pending" }, 404);
    // A private channel's agent asks the people in that channel.
    try {
      await deps.service.access.assertChannel(c.get("owner"), pending.channelId);
    } catch {
      return c.json({ error: "Question is not pending" }, 404);
    }
    if ("answers" in parsed.data && parsed.data.answers.length !== pending.questions.length)
      return c.json({ error: "Answer every question, or skip them" }, 400);
    try {
      await deps.tracker.answerQuestion(
        deps,
        requestId,
        "answers" in parsed.data ? parsed.data.answers : null,
      );
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Reply failed" }, 502);
    }
  });

  app.get("/channels/:channelId/permissions", async (c) => {
    const owner = c.get("owner");
    const channelId = c.req.param("channelId");
    const channels = await deps.service.listChannels(owner);
    if (!channels.some((channel) => channel.id === channelId))
      return c.json({ error: "Channel not found" }, 404);
    return c.json({ channelId, rules: await deps.rules.channelRules(owner, channelId) });
  });

  app.put("/channels/:channelId/permissions", async (c) => {
    const owner = c.get("owner");
    const channelId = c.req.param("channelId");
    const channels = await deps.service.listChannels(owner);
    if (!channels.some((channel) => channel.id === channelId))
      return c.json({ error: "Channel not found" }, 404);
    const parsed = rulesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { rules: string[] }" }, 400);
    const bad = invalidRuleLines(parsed.data.rules);
    if (bad.length > 0)
      return c.json({ error: `Invalid permission rules: ${bad.join("; ")}` }, 422);
    const rules = await deps.rules.setChannelRules(owner, channelId, parsed.data.rules);
    return c.json({ channelId, rules });
  });

  app.get("/channels/:channelId/permissions/mode", async (c) => {
    const owner = c.get("owner");
    const channelId = c.req.param("channelId");
    const channels = await deps.service.listChannels(owner);
    if (!channels.some((channel) => channel.id === channelId))
      return c.json({ error: "Channel not found" }, 404);
    return c.json({ channelId, mode: await deps.rules.channelMode(owner, channelId) });
  });

  app.put("/channels/:channelId/permissions/mode", async (c) => {
    const owner = c.get("owner");
    const channelId = c.req.param("channelId");
    const channels = await deps.service.listChannels(owner);
    if (!channels.some((channel) => channel.id === channelId))
      return c.json({ error: "Channel not found" }, 404);
    const parsed = modeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !isPermissionMode(parsed.data.mode))
      return c.json({ error: 'Body must be { mode: "ask" | "auto" }' }, 400);
    const mode = await deps.rules.setChannelMode(owner, channelId, parsed.data.mode);
    return c.json({ channelId, mode });
  });

  app.get("/threads/:threadId/permissions/rules", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    const [rules, channelRules] = await Promise.all([
      deps.rules.threadRules(owner, binding.channelId, threadId),
      deps.rules.channelRules(owner, binding.channelId),
    ]);
    return c.json({ threadId, channelId: binding.channelId, rules, channelRules });
  });

  app.put("/threads/:threadId/permissions/rules", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    const parsed = rulesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { rules: string[] }" }, 400);
    const bad = invalidRuleLines(parsed.data.rules);
    if (bad.length > 0)
      return c.json({ error: `Invalid permission rules: ${bad.join("; ")}` }, 422);
    const rules = await deps.rules.setThreadRules(
      owner,
      binding.channelId,
      threadId,
      parsed.data.rules,
    );
    return c.json({ threadId, channelId: binding.channelId, rules });
  });

  app.get("/threads/:threadId/permissions/mode", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    const [mode, channelMode] = await Promise.all([
      deps.rules.threadMode(owner, binding.channelId, threadId),
      deps.rules.channelMode(owner, binding.channelId),
    ]);
    return c.json({ threadId, channelId: binding.channelId, mode, channelMode });
  });

  app.put("/threads/:threadId/permissions/mode", async (c) => {
    const owner = c.get("owner");
    const threadId = c.req.param("threadId");
    const binding = await deps.service.channelOfThread(owner, threadId);
    if (!binding) return c.json({ error: "Thread is not bound to a channel" }, 404);
    const parsed = threadModeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Body must be { mode: "ask" | "auto" | null }' }, 400);
    const mode = await deps.rules.setThreadMode(
      owner,
      binding.channelId,
      threadId,
      parsed.data.mode,
    );
    return c.json({ threadId, channelId: binding.channelId, mode });
  });

  return app;
}
