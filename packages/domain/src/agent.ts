import { z } from "zod";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  /** The agent says it is finished. Only a person can mark the task done, or send it back. */
  | "in_review"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export const taskPriorities: TaskPriority[] = ["low", "medium", "high", "urgent"];
/** Kanban columns for the board view. */
export type TaskColumn = "todo" | "doing" | "done" | "failed";
export function taskColumn(status: TaskStatus): TaskColumn {
  switch (status) {
    case "running":
    case "waiting_approval":
    case "waiting_input":
    case "in_review":
      return "doing";
    case "failed":
      return "failed";
    case "succeeded":
    case "cancelled":
      return "done";
    default:
      return "todo";
  }
}
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
/** What a task's brief may hold. The server enforces these; the client checks before it uploads. */
export const taskBriefLimits = {
  noteChars: 4000,
  notes: 50,
  attachments: 10,
  attachmentBytes: 10 * 1024 * 1024,
  attachmentTotalBytes: 25 * 1024 * 1024,
} as const;
/** File types a task can carry: documents and images the agent can read. Keyed by extension. */
export const attachmentTypes: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};
/** A line of guidance on a task. Notes are append-only: the agent reads them in order, every run. */
export interface TaskNote {
  id: string;
  text: string;
  /** A plain note, an answer to a question the agent asked, or changes requested in review. */
  kind: "note" | "answer" | "feedback";
  createdAt: string;
  createdBy?: string;
  /** Display name for `createdBy`, filled in when the task is sent to a client. */
  createdByName?: string;
  /** True when the person it is sent to wrote it. Filled in when the task is sent to a client. */
  mine?: boolean;
  /** False until the agent has seen it: in a run's prompt, or sent live to the running session. */
  delivered: boolean;
}
/** A file attached to a task. The bytes live on the server; each run stages them for the agent. */
export interface TaskAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: string;
  addedBy?: string;
  /** Display name for `addedBy`, filled in when the task is sent to a client. */
  addedByName?: string;
  /** True when the person it is sent to attached it. Filled in when the task is sent to a client. */
  mine?: boolean;
  /** A PDF is also saved in Files, so the agent's PDF tools (inspect_pdf, fill_pdf) can open it. */
  fileId?: string;
  /** Signed download address, filled in when the task is sent to a client. */
  url?: string;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan" | "manual";
  status: TaskStatus;
  goalId?: string;
  /**
   * Who should do the work: null (unassigned) or "agent" (the worker runs it).
   * Assigning a manual issue to the agent converts it into an executable
   * agent task; unassigning reverts it to a manual issue.
   */
  assignee?: "agent" | null;
  /** The project it is in. Every task is in one: when none is named it is in General. */
  projectId?: string | null;
  /** Manual tasks are human work: no prompt execution, the worker never claims them. */
  priority: TaskPriority;
  /** ISO date (yyyy-mm-dd) for the timeline view. */
  startAt?: string | null;
  /** ISO date (yyyy-mm-dd) for the timeline view. */
  dueAt?: string | null;
  /** Task ids this task is waiting on. */
  blockedBy: string[];
  labels: string[];
  /** Owning channel. Tasks are claimed by the worker assigned to this channel. */
  channelId?: string;
  /** Channel where the work was requested. Differs from channelId after delegation. */
  originChannelId?: string;
  /** Where a delegated task currently sits: null, "orchestrator", or a channel id. */
  delegatedTo?: string | null;
  /** Why the task was delegated (shown in queue views). */
  delegationReason?: string;
  /** Thread the work was delegated from. A thread's task list is its work queue. */
  threadId?: string;
  /** Who asked for the work. Tasks are shared by everyone in the workspace. */
  createdBy?: string;
  /** Display name for `createdBy`, filled in when the task is sent to a client. */
  createdByName?: string;
  /** Guidance for whoever does the work, oldest first. The agent reads all of it on every run. */
  notes?: TaskNote[];
  /** Files the work needs. They are staged into the agent's workspace for each run. */
  attachments?: TaskAttachment[];
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  /** When the agent picked the task up for the run now going on. Only meaningful while it runs. */
  runStartedAt?: string;
  attempts: number;
  /**
   * Set when a run was cut off (the machine restarted, the process died, or the agent stalled) and
   * the task is waiting to be picked up again. The next run continues from where the last one got to
   * instead of starting over. Cleared when a run ends.
   */
  interruptedAt?: string | null;
  /** How many runs in a row were cut off by a crash or a stall; too many and the task is stopped. */
  interruptions?: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind:
    | "plan"
    | "step"
    | "observation"
    | "approval"
    | "result"
    | "error"
    | "status"
    | "message"
    | "tool"
    /** Something a person told the agent while it worked, or sent it back with. */
    | "instruction";
  runId?: string;
  sequence?: number;
  toolName?: string;
  toolCallId?: string;
  toolState?: string;
  toolInput?: unknown;
  title: string;
  detail: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
  createdBy?: string;
  /** The channel it came out of, kept as a label. It does not keep the task from anyone: who may see it is its project's say, and the agent that made it can read the machine it is kept on. */
  channelId?: string;
}
/**
 * Who may see and change a project's tasks. Open: everyone in the workspace sees and works on it.
 * Limited: everyone sees it, only its members work on it. Private: only its members see it.
 * (A guest is only ever in what they are a member of.)
 */
export const PROJECT_ACCESS = ["open", "limited", "private"] as const;
export type ProjectAccess = (typeof PROJECT_ACCESS)[number];
/** What a member of a project may do: run it, work on its tasks, or only look. */
export const PROJECT_ROLES = ["admin", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export interface ProjectMember {
  /** The address they sign in with. */
  email: string;
  role: ProjectRole;
}
/** The project a task is in when no other is named. It is always open, and cannot be deleted. */
export const GENERAL_PROJECT_ID = "general";
/** A project groups tasks on the board. Every task is in one. */
export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** Who may see and work on it; open when it does not say. */
  access?: ProjectAccess;
  members?: ProjectMember[];
  createdBy?: string;
  /** What the person it is sent to may do with it. Filled in when it is sent to them. */
  you?: { role: ProjectRole | null; canWork: boolean; canManage: boolean };
}
const projectMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(PROJECT_ROLES),
});
export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  access: z.enum(PROJECT_ACCESS).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  access: z.enum(PROJECT_ACCESS).optional(),
  /** All of its members, as they are to be: who is not named is not in it. */
  members: z.array(projectMemberSchema).max(200).optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
/** What becomes of a deleted project's tasks: they move to another project (General when it does not say), or are deleted with it. */
export const deleteProjectSchema = z
  .object({
    moveTo: z.string().trim().min(1).max(80).optional(),
    deleteTasks: z.boolean().optional(),
  })
  .refine((value) => !(value.moveTo && value.deleteTasks), {
    message: "Move the tasks or delete them, not both",
  });
export type DeleteProjectInput = z.infer<typeof deleteProjectSchema>;
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
  /** The channel the goal it comes from was made in, when only some of the team can open it: it stays there. */
  channelId?: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  /** The channel it was learned in, when only some of the team can open that channel: it stays there. */
  channelId?: string;
}
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  /** The channel this is about, as when someone mentioned the person in it. */
  channelId?: string;
  /** Who it is for, by email address. Without it, it is the whole workspace's. */
  to?: string[];
  /** The person a task's outcome is for (whoever started it), by id. */
  forUser?: string;
  /** Who it is from, when a person did it: their name and address, as when they mentioned someone. */
  byName?: string;
  by?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
/** What the workspace's machine tells of the agent: everything but the board, which the chat service keeps. */
export type AgentMachineView = Omit<AgentWorkspace, "tasks" | "projects">;
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  showChatUpdates?: boolean;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  projects: Project[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string };
}
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected yyyy-mm-dd")
  .refine((d) => !Number.isNaN(Date.parse(d)), "invalid date");
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000).optional(),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan", "manual"]).default("agent"),
  goalId: z.string().optional(),
  projectId: z.string().trim().min(1).max(80).optional(),
  channelId: z.string().trim().min(1).max(80).optional(),
  threadId: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  priority: taskPrioritySchema.default("medium"),
  startAt: isoDate.nullish(),
  dueAt: isoDate.nullish(),
  blockedBy: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  /** An agent task's instructions, or a manual task's description (which may be cleared). */
  prompt: z.string().trim().max(12000).optional(),
  status: z
    .enum([
      "queued",
      "running",
      "waiting_approval",
      "waiting_input",
      "in_review",
      "scheduled",
      "paused",
      "succeeded",
      "failed",
      "cancelled",
    ])
    .optional(),
  priority: taskPrioritySchema.optional(),
  goalId: z.string().nullable().optional(),
  /** A task can be moved to another project, never out of projects. */
  projectId: z.string().trim().min(1).max(80).optional(),
  startAt: isoDate.nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  blockedBy: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  assignee: z.enum(["agent"]).nullable().optional(),
  /** With `assignee: "agent"`: whether the agent also gets the channel's recent discussion. */
  channelContext: z.boolean().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
/** A note on a task. `run` also sends the task back to the agent (from review, a failure or done). */
export const addNoteSchema = z.object({
  text: z.string().trim().min(1).max(taskBriefLimits.noteChars),
  run: z.boolean().optional(),
});
export type AddNoteInput = z.infer<typeof addNoteSchema>;
/** Fixed id of the orchestrator channel: the control-plane surface. */
export const ORCHESTRATOR_CHANNEL_ID = "orchestrator";
export type ChannelStatus = "active" | "idle" | "archived";
export interface Channel {
  id: string;
  name: string;
  status: ChannelStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** PID of the spawned channel worker, when running. */
  workerPid?: number | null;
  lastActiveAt?: string | null;
  /** A line on what the channel is for. */
  topic?: string;
  /** When someone last wrote in the channel, and who (email address): the others' unread marks. */
  lastMessageAt?: string;
  lastMessageBy?: string;
  /**
   * Who can find the channel: anyone in the workspace but a guest (public), or only the people in
   * it (private). Missing means public.
   */
  visibility?: ChannelVisibility;
  /**
   * Whether everyone in the workspace, guests aside, is in the channel without being named, as in
   * a default channel. Missing means they are: every channel made before people could join
   * channels is open to the whole team, and stays so. A channel made now starts with the person
   * who made it.
   */
  everyone?: boolean;
  /**
   * The people named in the channel, by email address (lowercase): the guests, and whoever joined
   * or was added. A guest can open only the channels that name them, and so can anyone else in a
   * private channel.
   */
  members?: string[];
  /**
   * Whether the agent may be brought into the channel with a mention. A public channel has it unless this
   * says no; a private channel only where a manager has said yes (what the agent is shown stays on the
   * machine it runs on). Never in a direct message.
   */
  agent?: boolean;
  /**
   * The people who manage the channel, by email address (lowercase), a subset of its members.
   * Owners and admins manage every channel they can open.
   */
  managers?: string[];
  /**
   * A direct message: a private channel of two people (one, with themself), found by their names.
   * It cannot gain people, be left, made public or archived.
   */
  kind?: "dm";
}
export type ChannelVisibility = "public" | "private";
/** A channel as one person is shown it: what the list says of them and the channel. */
export interface ChannelView extends Channel {
  /** Whether this person is in the channel. Missing where the workspace keeps no list of people. */
  joined?: boolean;
  /** Whether this person manages the channel: its managers, the owner and the admins. */
  manager?: boolean;
  /** How many people are named in it. */
  count?: number;
  /** Whether someone else has written in it since this person last had it open. */
  unread?: boolean;
  /** Whether this person has muted it: no unread mark, and no notice from it. */
  muted?: boolean;
  /** For a direct message: the other person, whose name the channel goes by (`name` is it, as this person sees it). */
  dm?: { email: string; name: string };
}
/** Someone a direct message can be sent to. */
export interface DirectMessagePerson {
  email: string;
  name: string;
  /** Whether it is this person themself. */
  you: boolean;
}
/**
 * A channel as an owner or admin sees it in the list of every channel, private ones too: what it is
 * and who is in it, and nothing of what is said there.
 */
export interface ChannelDirectoryEntry {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  archived: boolean;
  /** Everyone in the workspace but guests is in it, named or not. */
  everyone: boolean;
  /** How many people are named in it. */
  count: number;
  /** Who manages it, by name where it is known. */
  managers: string[];
  /** Whether the person asking is in it. */
  joined: boolean;
}
/** The people in a channel, and what the person asking may do about them. */
export interface ChannelPeopleView {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  archived: boolean;
  /** Everyone in the workspace but guests is in the channel, named or not. */
  everyone: boolean;
  /** A line on what the channel is for; empty when it has none. */
  topic: string;
  /** Whether the agent may be brought in with a mention. */
  agent: boolean;
  /** The people named in it: its managers first. `role` is null for an address that has not signed in here yet. */
  people: {
    email: string;
    name: string;
    role: "owner" | "admin" | "member" | "guest" | null;
    manager: boolean;
  }[];
  /** People this workspace knows who are not in the channel, and whom the asker may add. */
  candidates: { email: string; name: string; role: "owner" | "admin" | "member" | "guest" }[];
  you: {
    in: boolean;
    manager: boolean;
    join: boolean;
    leave: boolean;
    add: boolean;
    remove: boolean;
    /** Whether they may put the channel away: its managers, and anyone in a private one. */
    archive: boolean;
    makePrivate: boolean;
    makePublic: boolean;
    setEveryone: boolean;
    /** Change the channel's topic. */
    topic: boolean;
    /** Switch the agent on or off in the channel. */
    agent: boolean;
    /** Take the channel away with everything in it: its managers, and the owner and admins. */
    delete: boolean;
  };
}
/** What a channel holds, so the person about to delete it sees what would go. */
export interface ChannelFootprint {
  messages: number;
  /** Conversations in threads, and the replies in them. */
  threads: number;
  files: number;
  fileBytes: number;
  people: number;
  /** The agent's work in it, which goes from the workspace machine too. */
  agentRuns: number;
}
const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That is not an email address");
/** People to put in a channel and people to take out, by email address. */
export const channelPeopleSchema = z.object({
  add: z.array(emailAddress).max(200).optional(),
  remove: z.array(emailAddress).max(200).optional(),
});
export type ChannelPeopleInput = z.infer<typeof channelPeopleSchema>;
export const channelSettingsSchema = z.object({
  visibility: z.enum(["public", "private"]).optional(),
  everyone: z.boolean().optional(),
  topic: z.string().trim().max(250).optional(),
  agent: z.boolean().optional(),
});
export type ChannelSettingsInput = z.infer<typeof channelSettingsSchema>;
/** What a person wants to be told about: their own, and kept by the workspace. Everything is on until they turn it off. */
export interface NotificationPrefs {
  /** When someone mentions them. */
  mentions: boolean;
  /** When work they asked for is done, or stops for them. */
  work: boolean;
  /** Channels they have muted, by id. */
  muted: string[];
}
export const notificationPrefsSchema = z.object({
  mentions: z.boolean().optional(),
  work: z.boolean().optional(),
  muted: z.array(z.string().min(1).max(200)).max(500).optional(),
});
export const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, and hyphens only")
    .optional(),
  visibility: z.enum(["public", "private"]).optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
/**
 * A conversation thread bound to a channel. The binding is stored as a JSON
 * file at `<channelWorkspaceDir>/threads/<threadId>.json` (OpenCode-style),
 * not in the records table. Bindings are append-only and never rebound.
 */
export interface ChannelThread {
  threadId: string;
  channelId: string;
  /** Display name; client-derived, defaults to "General" for the first thread. */
  name: string;
  createdAt: string;
  /**
   * The channel message this thread was forked from (reply or @hive mention).
   * Threads are auto-created from messages; there is no manual thread creation.
   */
  parentMessageId?: string;
  /**
   * Bound OpenCode session id. Persisted before
   * the first prompt so the thread can always find its session.
   */
  opencodeSessionId?: string;
}
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
  });
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default(""),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});
