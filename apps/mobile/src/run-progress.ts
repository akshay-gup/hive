/**
 * What the agent did while it worked on a reply, in words a person would use.
 *
 * Some tools have a card of their own in the chat (a page the browser read, an email, a file). Every
 * other tool call the agent makes, such as fetching a page, running a command or reading a file,
 * is a step in a short list that sits in the thread where the work happened.
 */

export type StepState = "running" | "done" | "failed" | "stopped";

export interface ProgressStep {
  id: string;
  label: string;
  /** What the step was about, shown when the list is open: a command, a file, the reason it failed. */
  detail?: string;
  state: StepState;
}

interface ToolCallLike {
  id: string;
  function: { name: string; arguments: string };
}
interface ToolMessageLike {
  role: string;
  toolCallId?: string;
  content?: unknown;
}

/** The tools the chat draws a card for. The chat registers its renderers for exactly these names. */
export const CARD_TOOLS: ReadonlySet<string> = new Set([
  "search_mail",
  "read_mail_thread",
  "browse_web",
  "present_choices",
  "send_file",
  "request_upload",
  "delegate_task",
  "create_goal",
  "watch_page",
  "remember_fact",
]);

/** The agent's own to-do list is scratch work, not something that happened. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["todowrite", "todoread"]);
/** Getting its bearings is not something the agent did, so these only show up if they fail. */
const QUIET_TOOLS: ReadonlySet<string> = new Set(["agent_status"]);

type Args = Record<string, unknown>;
type Wording = { running: string; done: string; failed: string; detail?: string };

function argsOf(call: ToolCallLike): Args {
  try {
    const value: unknown = JSON.parse(call.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function clip(value: string, length: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function site(url: unknown): string {
  const value = text(url);
  if (!value) return "a page";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return clip(value, 40);
  }
}

function file(args: Args): string {
  const path = text(args.filePath) ?? text(args.path) ?? text(args.file);
  return path ? (path.split(/[\\/]/).filter(Boolean).pop() ?? path) : "a file";
}

function humanize(name: string): string {
  return name.replace(/[_-]+/g, " ").trim() || "a tool";
}

/** How to say each tool's step. Tools that are not listed read as "Used <name>". */
function wording(name: string, args: Args): Wording {
  switch (name) {
    case "webfetch": {
      const page = site(args.url);
      return {
        running: `Fetching ${page}`,
        done: `Fetched ${page}`,
        failed: `Couldn't fetch ${page}`,
      };
    }
    case "websearch":
    case "codesearch": {
      const query = text(args.query);
      const about = query ? `“${clip(query, 50)}”` : "the web";
      return {
        running: `Searching for ${about}`,
        done: `Searched for ${about}`,
        failed: `Couldn't search for ${about}`,
      };
    }
    case "bash": {
      const command = text(args.description) ?? text(args.command);
      return {
        running: "Running a command",
        done: "Ran a command",
        failed: "A command failed",
        detail: command ? clip(command, 90) : undefined,
      };
    }
    case "read":
      return {
        running: `Reading ${file(args)}`,
        done: `Read ${file(args)}`,
        failed: `Couldn't read ${file(args)}`,
      };
    case "write":
      return {
        running: `Writing ${file(args)}`,
        done: `Wrote ${file(args)}`,
        failed: `Couldn't write ${file(args)}`,
      };
    case "edit":
    case "patch":
    case "apply_patch":
      return {
        running: `Editing ${file(args)}`,
        done: `Edited ${file(args)}`,
        failed: `Couldn't edit ${file(args)}`,
      };
    case "glob":
    case "grep":
    case "list": {
      const looked = text(args.pattern) ?? text(args.path);
      return {
        running: "Looking through files",
        done: "Looked through files",
        failed: "Couldn't look through files",
        detail: looked ? clip(looked, 90) : undefined,
      };
    }
    case "task": {
      const about = text(args.description);
      return {
        running: "Asking a helper",
        done: "Asked a helper",
        failed: "A helper didn't finish",
        detail: about ? clip(about, 90) : undefined,
      };
    }
    case "skill": {
      const skill = text(args.name);
      return {
        running: "Using a skill",
        done: "Used a skill",
        failed: "Couldn't use a skill",
        detail: skill,
      };
    }
    case "agent_status":
      return {
        running: "Checking tasks, goals and ideas",
        done: "Checked tasks, goals and ideas",
        failed: "Couldn't check tasks, goals and ideas",
      };
    case "create_issue":
      return {
        running: "Creating a ticket",
        done: "Created a ticket",
        failed: "Couldn't create the ticket",
        detail: text(args.title),
      };
    case "update_task":
      return {
        running: "Updating a ticket",
        done: "Updated a ticket",
        failed: "Couldn't update the ticket",
        detail: text(args.title),
      };
    case "delete_task":
      return {
        running: "Deleting a ticket",
        done: "Deleted a ticket",
        failed: "Couldn't delete the ticket",
      };
    case "create_project":
      return {
        running: "Creating a project",
        done: "Created a project",
        failed: "Couldn't create the project",
        detail: text(args.name) ?? text(args.title),
      };
    case "update_project":
      return {
        running: "Updating a project",
        done: "Updated a project",
        failed: "Couldn't update the project",
        detail: text(args.name) ?? text(args.title),
      };
    case "delete_project":
      return {
        running: "Deleting a project",
        done: "Deleted a project",
        failed: "Couldn't delete the project",
      };
    default: {
      const tool = humanize(name);
      return { running: `Using ${tool}`, done: `Used ${tool}`, failed: `${tool} didn't work` };
    }
  }
}

/** The reason a tool call failed, or undefined if it did not. The server sends `error: <why>`. */
function failureOf(result: string): string | undefined {
  if (result.startsWith("error:")) return result.slice("error:".length).trim() || "It failed";
  try {
    const value: unknown = JSON.parse(result);
    const reason = value && typeof value === "object" ? (value as Args).error : undefined;
    return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One tool call as a step. `result` is what the tool returned, if it has returned yet; `running` says
 * whether the run it belongs to is still going, which tells a step that is under way from one that
 * was cut off. Returns null for a call that is not worth showing.
 */
export function progressStep(
  call: ToolCallLike,
  result: string | undefined,
  running: boolean,
): ProgressStep | null {
  const name = call.function.name;
  if (HIDDEN_TOOLS.has(name)) return null;
  const failure = result === undefined ? undefined : failureOf(result);
  if (QUIET_TOOLS.has(name) && !failure) return null;
  const words = wording(name, argsOf(call));
  if (result === undefined) {
    return {
      id: call.id,
      label: words.running,
      detail: running ? words.detail : (words.detail ?? "Stopped before it finished"),
      state: running ? "running" : "stopped",
    };
  }
  if (failure)
    return { id: call.id, label: words.failed, detail: clip(failure, 160), state: "failed" };
  return { id: call.id, label: words.done, detail: words.detail, state: "done" };
}

export type ProgressItem<Call = ToolCallLike, Message = ToolMessageLike> =
  | { kind: "card"; id: string; toolCall: Call; toolMessage?: Message }
  | { kind: "steps"; id: string; steps: ProgressStep[] };

/**
 * An assistant message's tool calls in the order they happened: a card for each tool that has one,
 * and the steps between them gathered into one list.
 */
export function progressItems<Call extends ToolCallLike, Message extends ToolMessageLike>(
  toolCalls: readonly Call[],
  messages: readonly Message[],
  running: boolean,
): ProgressItem<Call, Message>[] {
  const items: ProgressItem<Call, Message>[] = [];
  let steps: ProgressStep[] = [];
  const flush = () => {
    if (steps.length) items.push({ kind: "steps", id: `steps-${steps[0].id}`, steps });
    steps = [];
  };
  for (const toolCall of toolCalls) {
    const toolMessage = messages.find(
      (candidate) => candidate.role === "tool" && candidate.toolCallId === toolCall.id,
    );
    if (CARD_TOOLS.has(toolCall.function.name)) {
      flush();
      items.push({ kind: "card", id: toolCall.id, toolCall, toolMessage });
      continue;
    }
    const result = typeof toolMessage?.content === "string" ? toolMessage.content : undefined;
    const step = progressStep(toolCall, result, running);
    if (step) steps.push(step);
  }
  flush();
  return items;
}

/**
 * Whether a step that is under way is on screen, with its own spinner. When one is, nothing else
 * needs to say the agent is working: one thing moving is enough.
 */
export function showsRunningStep(items: readonly ProgressItem<unknown, unknown>[]): boolean {
  return items.some(
    (item) => item.kind === "steps" && item.steps.some((step) => step.state === "running"),
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "12 seconds", "3 minutes", "1 hour 5 minutes": how long the agent worked, in words. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return count(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${count(hours, "hour")}${rest ? ` ${count(rest, "minute")}` : ""}`;
}

/**
 * One line for a list of steps: what is happening now, or how the work went. Said as a time when
 * it is known and worth saying ("Worked for 3 minutes"), as a number of steps otherwise.
 */
export function summarizeSteps(steps: readonly ProgressStep[], elapsedMs?: number): string {
  const current = steps.filter((step) => step.state === "running").at(-1);
  if (current) return `Working · ${current.label}`;
  const failed = steps.filter((step) => step.state === "failed").length;
  if (steps.some((step) => step.state === "stopped"))
    return `Stopped · ${count(steps.length, "step")}`;
  const missed = failed ? ` · ${failed} didn't work` : "";
  if (elapsedMs !== undefined && elapsedMs >= 5000)
    return `Worked for ${formatElapsed(elapsedMs)}${missed}`;
  return `Worked through ${count(steps.length, "step")}${missed}`;
}
