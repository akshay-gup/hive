import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MessageSchema } from "@ag-ui/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import { emailDraftSchema, proposalSchema } from "../../../packages/domain/src/index.ts";
import { ActionService } from "./actions.ts";
import { makeRuntime } from "./agent.ts";
import { KernelWatch } from "./agent-watch/kernel.ts";
import { AgentWatch } from "./agent-watch/watch.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { channelGate } from "./channel-gate.ts";
import { BorrowedFiles } from "./chat-runner/attachments.ts";
import { TaskBorrower } from "./chat-runner/borrow.ts";
import { ChatRunnerHost } from "./chat-runner/host.ts";
import { RunnerLink, type SocketFactory } from "./chat-runner/link.ts";
import { standInFor, vouchFor } from "./chat-runner/stubs.ts";
import { WorkLink } from "./chat-runner/work-link.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import {
  channelAuthors,
  conversationHome,
  saveSharedConversation,
} from "./engine/shared-conversations.ts";
import { LocalDiskThreadStore, type ThreadBindingStore } from "./engine/threads.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import type { JevAdapter } from "./jev/adapter.ts";
import { createJevService } from "./jev/service.ts";
import { publishLiveRuns } from "./live-runs.ts";
import { backgroundFailure } from "./log.ts";
import { ManagedSignIn } from "./managed.ts";
import { HiveToolBridge } from "./opencode/hive-tools.ts";
import {
  connectionFromConfig,
  ensureOpencodeServerReachable,
  OpencodeClientPool,
  OpencodeEventBus,
  opencodePermissionRoutes,
  opencodeShimRoutes,
  PermissionRulesStore,
  PermissionTracker,
  sessionDirectory,
} from "./opencode/index.ts";
import { mergeMessages, type RecordedMessage } from "./opencode/run-record.ts";
import { readUpdateStatus } from "./update-status.ts";
import { serveWebFile, webRootDir } from "./web-static.ts";
import { WorkspaceService } from "./workspace.ts";

/**
 * What this build can do beyond what every build could, by name. The app reads the list and hides a
 * control whose name is missing, so a workspace running an older build is never offered what it
 * cannot do. Add a name here in the commit that adds the feature, and never remove one.
 */
export const SERVER_FEATURES = ["notifications-dismiss"];

/**
 * The build's version: the image tag (HIVE_VERSION, or the VERSION file the image is built with),
 * and "dev" for a build from a checkout.
 */
function readVersion(): string {
  const fromEnv = process.env.HIVE_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync("VERSION", "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}
export const SERVER_VERSION = readVersion();

export async function createApp(
  db: Store,
  config: Config,
  options: {
    threads?: ThreadBindingStore;
    jevAdapter?: JevAdapter;
    /** How the connection to the chat service is made, for a test that stands in for it. */
    chatRunner?: { fetcher?: typeof fetch; socket?: SocketFactory };
  } = {},
) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    options.threads ?? new LocalDiskThreadStore(config.dataDir),
    createJevService(db, config, options.jevAdapter),
  );
  const runtime = makeRuntime(config);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  // A channel file's link is its own credential, and keeps its token in the path so the files a page
  // refers to inherit it. Any page may read one: a page an agent made runs in a sandbox with no
  // origin of its own, and still has to load its fonts and modules.
  const fileLink = /^\/api\/agent\/channels\/[^/]+\/view\/([\w.-]+)\/./;
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin) && !fileLink.test(c.req.path))
      return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin, c) =>
        origins.has(origin) ? origin : fileLink.test(c.req.path) ? "*" : undefined,
      allowHeaders: ["Content-Type", "Authorization", "X-Hive-Board"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: "Request is too large; files must be 10 MB or smaller" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[Hive] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  // Whether the connection to the chat service is up, for the health answer (set where it is made).
  let agentConnected: (() => boolean) | undefined;
  app.get("/api/health", async (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      version: SERVER_VERSION,
      features: SERVER_FEATURES,
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
      // A managed workspace says which one it is, so the control plane and the app can tell they
      // reached the right one.
      ...(config.managed ? { managed: true, workspace: config.managed.workspaceId } : {}),
      ...(config.managed ? { update: await readUpdateStatus() } : {}),
      // Whether the agent can be reached from chat: the control plane waits for it before it calls a new workspace ready.
      ...(agentConnected ? { chatRunner: { connected: agentConnected() } } : {}),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  const limitSignIns = () => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
  };
  app.post("/api/session", async (c) => {
    limitSignIns();
    const session = await auth.session();
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to Hive.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    if ((await google.callbackPurpose(state)) === "login") {
      if (config.managed) throw new AppError("Sign in through your Hive account", 404);
      const profile = await google.loginCallback(state, code);
      const owner = `google:${profile.sub}`;
      const now = new Date().toISOString();
      interface HiveUser {
        id: string;
        email: string;
        name: string;
        createdAt: string;
        lastLoginAt: string;
      }
      const existing = await db.get<HiveUser>("system", "users", owner);
      await db.put("system", "users", {
        id: owner,
        email: profile.email,
        name: profile.name ?? profile.email,
        createdAt: existing?.createdAt ?? now,
        lastLoginAt: now,
      });
      await agent.ensure(owner);
      const session = await auth.sessionForOwner(owner);
      const loginCode = await google.mintLoginCode(session.token, session.mode, profile.challenge);
      const target = profile.origin ? JSON.stringify(profile.origin) : "null";
      return c.html(
        `<!doctype html><html><head><meta charset="utf-8"><title>Hive sign-in</title></head>` +
          `<body><h1>Signed in to Hive</h1><p>You can return to the app.</p><script>` +
          `(function(){var code=${JSON.stringify(loginCode)},target=${target};` +
          `if(window.opener&&target){window.opener.postMessage({hiveAuthCode:code},target);` +
          `setTimeout(function(){window.close();},400);}` +
          `else{window.location.replace("hive://auth?code="+encodeURIComponent(code));}})();` +
          `</script></body></html>`,
      );
    }
    await google.callback(state, code);
    return c.html("<h1>Google is connected</h1><p>Return to Hive and refresh your workspace.</p>");
  });
  /**
   * Public: start Google sign-in, returns the OAuth URL to open. A web page names its `origin`;
   * an app sends the `challenge` (the SHA-256 of a proof it keeps) that `/api/auth/exchange` asks for.
   */
  app.get("/api/auth/google/url", async (c) => {
    if (config.managed) throw new AppError("Sign in through your Hive account", 404);
    const origin = c.req.query("origin");
    // The page that opened the sign-in is handed the result, so it has to be one of this server's own.
    if (origin && !origins.has(origin)) throw new AppError("Origin is not allowed", 403);
    const challenge = c.req.query("challenge");
    return c.json(await google.loginUrl(origin || undefined, challenge || undefined));
  });
  /**
   * Public: sign in with a token the Hive control plane signed for this workspace. Only a managed
   * workspace has this; anywhere else people sign in with Google.
   */
  const managed = config.managed
    ? new ManagedSignIn(db, auth, config.managed, (owner, role) =>
        // A guest has no orchestrator chat of their own to make ready.
        role === "guest" ? undefined : agent.ensure(owner),
      )
    : undefined;
  app.post("/api/auth/managed", async (c) => {
    if (!managed) throw new AppError("This workspace signs in with Google", 404);
    limitSignIns();
    const body = z.object({ token: z.string().min(1).max(4096) }).parse(await c.req.json());
    return c.json(await managed.signIn(body.token));
  });
  /** Public: the control plane ends a person's sessions here, as it signs a token to say so. */
  app.post("/api/auth/revoke", async (c) => {
    if (!managed) throw new AppError("This workspace signs in with Google", 404);
    const body = z.object({ token: z.string().min(1).max(4096) }).parse(await c.req.json());
    return c.json(await managed.revoke(body.token));
  });
  /** Public: exchange a single-use login code (and the proof, if it was started with a challenge) for the session token. */
  app.post("/api/auth/exchange", async (c) => {
    const body = z
      .object({ code: z.string().min(1), proof: z.string().max(256).optional() })
      .parse(await c.req.json());
    return c.json(await google.exchangeLoginCode(body.code, body.proof));
  });
  const hiveTools = new HiveToolBridge(`http://127.0.0.1:${config.port}/api/hive-tools`);
  app.route("/api/hive-tools", hiveTools.routes);
  /**
   * What the app gave each person to let the agent change the board in the app's own chat with it (the chat
   * service made it for them and checks it). Kept in memory, so it is gone when the machine restarts and the
   * app gives the next one with its next request.
   */
  const boardTickets = new Map<string, string>();
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/agent\/tasks\/[^/]+\/attachments\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$|^\/api\/browser-shots\/[0-9a-f-]{36}$/.test(
        c.req.path,
      );
    const view = fileLink.exec(c.req.path);
    const owner = view
      ? files.verifyToken(view[1]).owner
      : signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    const ticket = c.req.header("x-hive-board");
    if (ticket && ticket.length <= 2000) boardTickets.set(owner, ticket);
    // A guest is let through only to what the channels they were added to hold, and anyone else
    // not to the private channels that are not theirs.
    if (config.managed) await channelGate(c, owner, agent);
    await next();
  });
  app.get("/api/auth/session", (c) => c.json({ authenticated: true }));
  app.post("/api/auth/logout", async (c) => {
    await auth.logout(c.req.header("authorization")!);
    return c.json({ ok: true });
  });
  app.get("/api/workspace", async (c) => {
    // The mail, calendar and files are the team's, not a guest's: they are shown who they are.
    if (await agent.access.isGuest(c.get("owner")))
      return c.json(await workspace.guestSnapshot(c.get("owner")));
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
    ]);
    snapshot.browsers = (await agent.visibleBrowsers(c.get("owner"), snapshot.browsers)).map((s) =>
      browser.decorate(c.get("owner"), s),
    );
    // What the agent prepared for a private channel's task is for the people in that channel.
    const shown = await agent.visibleReviews(c.get("owner"), snapshot.actions, snapshot.activity);
    snapshot.actions = shown.reviews;
    snapshot.activity = shown.receipts;
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  // OpenCode is the agent: chat runs through the AG-UI shim and tasks run as OpenCode sessions.
  // Building these does no I/O, so a test can swap the runtime for a stand-in. `opencode.start()`
  // is what reaches the server, and the entry points call it before they serve anything.
  const connection = connectionFromConfig(config);
  const bus = new OpencodeEventBus(connection);
  const pool = new OpencodeClientPool(connection);
  const tracker = new PermissionTracker();
  const rules = new PermissionRulesStore(config.dataDir);
  // How many runs are going, where whatever restarts the workspace can see it. The marks outlive a
  // restart (the runs are taken up again), so what is counted at the start is what is about to resume.
  const publishRuns = async () =>
    publishLiveRuns(
      config.dataDir,
      (await db.list(SHARED_OWNER, "live-runs").catch(() => [])).length +
        (await db.list(SHARED_OWNER, "live-chat-runs").catch(() => [])).length,
    );
  // Runs for the chat service end with a restart (the chat service is told they were lost), so what is
  // left of them from before is not counted.
  void db
    .removeBelow(SHARED_OWNER, "live-chat-runs", "startedAt", Number.MAX_SAFE_INTEGER)
    .catch(() => 0)
    .then(publishRuns);
  // Marks what a run opens of the machine's own data, and tells the chat service when it is reachable.
  const watch = new AgentWatch({
    dataDir: config.dataDir,
    env: process.env,
    send: (frame) => chatLink?.link.send(frame) ?? false,
    log: (line) => console.log(line),
  });
  // On a machine with a kernel watch (a folder it writes in), what it sees is passed to the watch, and a watch
  // that has gone quiet is treated as a reason to stop what is running when refusing is on.
  const kernel =
    config.kernelWatchDir && existsSync(config.kernelWatchDir)
      ? new KernelWatch({ dir: config.kernelWatchDir, watch, log: (line) => console.log(line) })
      : null;
  const shimDeps = {
    watch,
    service: agent,
    bus,
    pool,
    config,
    tracker,
    rules,
    hiveTools,
    runMarks: {
      set: async (threadId: string, owner: string) => {
        await db.put(SHARED_OWNER, "live-runs", { id: threadId, owner, startedAt: Date.now() });
        await publishRuns();
      },
      clear: async (threadId: string) => {
        await db.remove(SHARED_OWNER, "live-runs", threadId);
        await publishRuns();
      },
      all: async () =>
        (
          await db.list<{ id: string; owner: string; startedAt: number }>(SHARED_OWNER, "live-runs")
        ).map((mark) => ({ threadId: mark.id, owner: mark.owner, startedAt: mark.startedAt })),
    },
    loadMessages: async (owner: string, threadId: string) => {
      const id = conversationKey(threadId);
      const home = await conversationHome(id, owner, (o, t) => agent.channelOfThread(o, t));
      const stored = await db.get<{ messages?: unknown[] }>(home.owner, "conversations", id);
      return stored?.messages ?? [];
    },
    // What the agent does is kept as it happens, so closing the page does not lose it.
    saveMessages: async (owner: string, threadId: string, added: RecordedMessage[]) => {
      const id = conversationKey(threadId);
      const home = await conversationHome(id, owner, (o, t) => agent.channelOfThread(o, t));
      const stored = await db.get<{ messages?: RecordedMessage[] }>(
        home.owner,
        "conversations",
        id,
      );
      const merged = mergeMessages(stored?.messages ?? [], added).slice(-1000);
      await saveConversation(
        id,
        owner,
        merged.map((message) => MessageSchema.parse(message)),
      );
    },
  };
  const shim = opencodeShimRoutes(shimDeps);
  app.route("/api/agent/opencode", shim);
  // Give OpenCode a moment to come up, then carry on any reply a restart cut off.
  setTimeout(() => void shim.resume().catch(() => undefined), 15_000).unref?.();
  app.route("/api/agent/opencode", opencodePermissionRoutes(shimDeps));
  agent.opencodeRuntime = { bus, pool, tracker, config, hiveTools, watch };
  // Where the chat service starts the agent's runs: this machine connects out to it and does what it is given.
  const chatLink = config.chatRunner
    ? (() => {
        let host!: ChatRunnerHost;
        const link: RunnerLink = new RunnerLink({
          tokenUrl: config.chatRunner.tokenUrl,
          key: config.chatRunner.key,
          onFrame: (frame) => host.onFrame(frame),
          onOpen: () => {
            host.onOpen();
            watch.flush();
          },
          onClose: () => host.onClose(),
          fetcher: options.chatRunner?.fetcher,
          socket: options.chatRunner?.socket,
          log: (line) => console.log(line),
        });
        const work = new WorkLink({
          send: (frame) => link.send(frame),
          history: (ask) => agent.history(ask),
        });
        const borrower = new TaskBorrower({
          send: (frame) => link.send(frame),
          copies: {
            get: (owner, id) => db.get<AgentTask>(owner, "tasks", id),
            put: async (owner, task) => void (await db.put(owner, "tasks", task)),
            remove: (owner, id) => db.remove(owner, "tasks", id),
            addNotes: async (owner, id, notes) => {
              for (const note of notes) await db.appendItem(owner, "tasks", id, "notes", note);
            },
            addFiles: async (owner, id, files) => {
              for (const file of files)
                await db.appendItem(owner, "tasks", id, "attachments", file);
            },
          },
          files: new BorrowedFiles({
            taskFiles: agent.taskFiles,
            files: agent.files,
            origin: () => link.origin,
            workspaceOf: (task, owner) => agent.workspaceOf(task, owner),
            fetcher: options.chatRunner?.fetcher,
            log: (line) => console.log(line),
          }),
          prepare: async (start) => {
            await vouchFor(agent, start.owner);
            if (start.channel) await standInFor(agent, start.channel);
            else await agent.ensureOrchestratorChannel(start.owner.id);
          },
          run: () =>
            void agent.worker.tick().catch((error) => backgroundFailure("task worker", error)),
          abort: (id) => agent.worker.abort(id),
          log: (line) => console.log(line),
        });
        agent.taskFinished = (owner, task) => borrower.finished(owner, task);
        const board = work.board({
          leaseOf: (taskId) => borrower.leaseOf(taskId),
          ticketOf: (owner) => boardTickets.get(owner),
        });
        agent.board = board;
        host = new ChatRunnerHost({
          tasks: borrower,
          outcome: (task) => agent.outcome(task),
          work,
          board,
          send: (frame) => link.send(frame),
          service: agent,
          launcher: shim,
          tracker,
          replies: { bus, pool },
          channelFiles: agent.channelFiles,
          origin: () => link.origin,
          setWatchMode: (mode) => watch.setMode(mode),
          refusal: () => watch.refusal(),
          directoryOf: (channelId, owner) => sessionDirectory(config, owner, channelId),
          standIns: () => agent.standInIds(),
          forgetChannel: (channelId) => agent.purgeChannel(channelId),
          marks: {
            set: async (runId) => {
              await db.put(SHARED_OWNER, "live-chat-runs", { id: runId, startedAt: Date.now() });
              await publishRuns();
            },
            clear: async (runId) => {
              await db.remove(SHARED_OWNER, "live-chat-runs", runId);
              await publishRuns();
            },
          },
          fetcher: options.chatRunner?.fetcher,
          log: (line) => console.log(line),
        });
        agentConnected = () => link.open;
        return { link, host };
      })()
    : undefined;
  const opencode = {
    /** Fails loudly when `opencode serve` cannot be reached, rather than serving a dead agent. */
    async start() {
      const { version } = await ensureOpencodeServerReachable(connection);
      console.log(`OpenCode server reachable at ${connection.url} (v${version})`);
      bus.start();
      kernel?.start();
      chatLink?.link.start();
    },
    stop: () => {
      kernel?.stop();
      chatLink?.link.stop();
      chatLink?.host.stop();
      return bus.stop();
    },
  };
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (
      query.timeMin &&
      query.timeMax &&
      (Date.parse(query.timeMax) <= Date.parse(query.timeMin) ||
        Date.parse(query.timeMax) - Date.parse(query.timeMin) > 366 * 86400000)
    )
      throw new AppError("Choose a calendar range between one moment and 366 days", 422);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/drive/files", async (c) => {
    const query = z.object({ q: z.string().max(500).optional() }).parse(c.req.query());
    return c.json(await workspace.listDriveFiles(c.get("owner"), query.q));
  });
  app.get("/api/drive/files/:id", async (c) =>
    c.json(await workspace.getDriveFile(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema.extend({ id: z.string().optional() }).parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/conversation", async (c) => {
    const id = conversationKey(c.req.query("threadId"));
    const { owner } = await conversationHome(id, c.get("owner"), (o, t) =>
      agent.channelOfThread(o, t),
    );
    // What the agent wrote under "local-main" before the two names were one is brought in.
    if (id === "default") {
      const stray = await db.get<{ messages?: RecordedMessage[] }>(
        owner,
        "conversations",
        "local-main",
      );
      if (stray?.messages?.length) {
        const own = await db.get<{ messages?: RecordedMessage[] }>(owner, "conversations", id);
        const merged = mergeMessages(own?.messages ?? [], stray.messages);
        await db.put(owner, "conversations", { id, messages: merged });
        await db.remove(owner, "conversations", "local-main");
      }
    }
    return c.json((await db.get(owner, "conversations", id)) ?? { messages: [] });
  });
  const saveConversation = async (
    id: string,
    sessionOwner: string,
    incoming: ReturnType<typeof MessageSchema.parse>[],
  ) => {
    const home = await conversationHome(id, sessionOwner, (o, t) => agent.channelOfThread(o, t));
    if (home.owner === SHARED_OWNER) {
      // A thread forked from a channel starts as copies of channel messages that keep their author.
      const inherited =
        home.channelId && !id.startsWith("channel:")
          ? await channelAuthors(db, home.channelId)
          : undefined;
      await saveSharedConversation(db, id, sessionOwner, incoming, inherited);
    } else await db.put(home.owner, "conversations", { id, messages: incoming });
  };
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const incoming = z
      .array(z.unknown())
      .max(1000)
      .parse(body.messages)
      .map((message) => MessageSchema.parse(message));
    await saveConversation(conversationKey(c.req.query("threadId")), c.get("owner"), incoming);
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  // A picture of a page the agent read, kept with the conversation. The link is short-lived; the
  // name in the conversation is not.
  app.get("/api/browser-shots/:name/link", async (c) => {
    const name = c.req.param("name");
    await browser.shot(c.get("owner"), name);
    return c.json({ url: auth.sign(c.get("owner"), `/api/browser-shots/${name}`) });
  });
  app.get("/api/browser-shots/:name", async (c) => {
    const bytes = await browser.shot(c.get("owner"), c.req.param("name"));
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(new Uint8Array(bytes));
  });
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    await browser.input(c.get("owner"), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  app.get("/", (c) => {
    const webRoot = webRootDir(config.webDir);
    return webRoot
      ? serveWebFile(c, webRoot, "index.html")
      : c.json({ name: "Hive", health: "/api/health" });
  });
  {
    // Same-origin web UI: unknown non-API routes fall back to the app shell.
    const webRoot = webRootDir(config.webDir);
    if (webRoot) {
      app.get("/*", (c) => {
        const pathname = new URL(c.req.url).pathname;
        if (pathname === "/api" || pathname.startsWith("/api/")) return c.notFound();
        return serveWebFile(c, webRoot, decodeURIComponent(pathname));
      });
    }
  }
  return { app, auth, files, actions, workspace, agent, opencode, watch };
}

/**
 * Conversation storage key for the keyless chat. The main chat keeps the
 * legacy "default" key; channel threads persist under their thread id so each
 * thread keeps its own history.
 */
/**
 * Where a conversation is kept. The main chat has no thread id of its own on the page's side
 * (it reads and writes `/api/conversation`), but the agent knows it as "local-main": both are one
 * record, or what the agent writes is not what a reload shows.
 */
export function conversationKey(threadId: string | undefined): string {
  const id = (threadId ?? "").trim().slice(0, 128);
  return id && id !== "local-main" ? id : "default";
}
