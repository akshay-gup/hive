import {
  type AgentExtra,
  type PromptState,
  REASON_TEXT,
  RUN_STATUS,
} from "../../../packages/domain/src/chat-agent";
import { mentionsIn } from "../../../packages/domain/src/mentions";
import {
  mergeItems,
  type ProgressStep,
  progressItems,
  showsRunningStep,
  summarizeSteps,
} from "./run-progress";

/** A card the agent put in its reply: choices to pick from, or a request for files. */
export interface AgentCard {
  id: string;
  name: "present_choices" | "request_upload";
  /** What the tool returned, as the chat holds it; none yet while it is still being made. */
  result: unknown;
  loading: boolean;
}

const CHANNEL_CARDS: ReadonlySet<string> = new Set(["present_choices", "request_upload"]);

/** A stretch of an agent's reply: what it did, how far its words go, and what it asked after that. */
export interface AgentSegment {
  steps: ProgressStep[];
  /** Its choices and requests for files, shown after its words. */
  cards: AgentCard[];
  /** Where its words end in the reply's text; to the end, for the last stretch. */
  endsAt: number | null;
  /** What was asked at the end of it. */
  prompts: PromptState[];
}

/** What the screen shows of an agent's reply to a mention. */
export interface AgentView {
  runId: string;
  askedBy: string;
  /** Waiting for the agent's machine, or for a turn on it. */
  queued: boolean;
  /** Being written now. */
  working: boolean;
  /** How it ended, if it did and not well. */
  ended?: { status: "failed" | "stopped"; text: string };
  /** What it did, in order, as the lists the chat already draws. */
  steps: ProgressStep[];
  /** The same, split where it asked something, so each question comes up where it was asked. */
  segments: AgentSegment[];
  /** A step is under way, which has its own spinner. */
  stepMoving: boolean;
  /** What it asks of the people, the unanswered first. */
  prompts: PromptState[];
  /** What it asks now: still waiting for someone. */
  waiting: boolean;
}

interface Call {
  id: string;
  function: { name: string; arguments: string };
}
interface Step {
  id?: string;
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: Call[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCall = (value: unknown): value is Call =>
  isRecord(value) &&
  typeof value.id === "string" &&
  isRecord(value.function) &&
  typeof value.function.name === "string" &&
  typeof value.function.arguments === "string";

/**
 * `extra` of an agent's message as a view, or null when it is not one this app can read (a newer form, or
 * not an agent's): the message is then shown as plain words. Nothing in it is trusted to be well formed.
 */
export function agentView(extra: unknown): AgentView | null {
  if (!isRecord(extra) || (extra.v !== 1 && extra.v !== 2) || typeof extra.runId !== "string")
    return null;
  const status = extra.status;
  if (!RUN_STATUS.includes(status as AgentExtra["status"])) return null;
  const rawSteps = Array.isArray(extra.steps) ? (extra.steps as unknown[]) : [];
  const calls: Call[] = [];
  const results: Step[] = [];
  for (const raw of rawSteps) {
    if (!isRecord(raw)) continue;
    const step = raw as Step;
    if (step.role === "assistant" && Array.isArray(step.toolCalls))
      calls.push(...step.toolCalls.filter(isCall));
    else if (step.role === "tool" && typeof step.toolCallId === "string") results.push(step);
  }
  const going = status === "working" || status === "queued";
  // Of the agent's cards only choices and requests for files are drawn in a channel; another that
  // shows up is left out.
  const items = mergeItems(progressItems(calls, results as never[], going));
  const steps = items.flatMap((item) => (item.kind === "steps" ? item.steps : []));
  const prompts = (Array.isArray(extra.prompts) ? (extra.prompts as PromptState[]) : []).filter(
    (p) => isRecord(p) && isRecord(p.prompt) && typeof p.prompt.id === "string",
  );
  // What was asked, in the order it came up; one that does not say where goes after everything else.
  const placed = prompts
    .filter((p) => isRecord(p.after))
    .sort(
      (a, b) =>
        (a.after?.steps ?? 0) - (b.after?.steps ?? 0) ||
        (a.after?.chars ?? 0) - (b.after?.chars ?? 0),
    );
  const loose = prompts.filter((p) => !isRecord(p.after));
  const callsIn: Call[][] = Array.from({ length: placed.length + 1 }, () => []);
  rawSteps.forEach((raw, index) => {
    if (!isRecord(raw) || raw.role !== "assistant" || !Array.isArray(raw.toolCalls)) return;
    let at = 0;
    while (at < placed.length && index >= (placed[at]?.after?.steps ?? 0)) at++;
    callsIn[at]?.push(...(raw.toolCalls as unknown[]).filter(isCall));
  });
  const segmentItems = callsIn.map((own, at) =>
    mergeItems(progressItems(own, results as never[], going && at === placed.length)),
  );
  const segments: AgentSegment[] = segmentItems.map((own, at) => ({
    steps: own.flatMap((item) => (item.kind === "steps" ? item.steps : [])),
    cards: own.flatMap((item): AgentCard[] =>
      item.kind === "card" && CHANNEL_CARDS.has(item.toolCall.function.name)
        ? [
            {
              id: item.id,
              name: item.toolCall.function.name as AgentCard["name"],
              result: (item.toolMessage as Step | undefined)?.content,
              loading: !item.toolMessage,
            },
          ]
        : [],
    ),
    endsAt: at < placed.length ? (placed[at]?.after?.chars ?? 0) : null,
    prompts: at < placed.length ? [placed[at] as PromptState] : loose,
  }));
  const reason = typeof extra.reason === "string" ? extra.reason : undefined;
  return {
    runId: extra.runId,
    askedBy: typeof extra.askedBy === "string" ? extra.askedBy : "",
    queued: status === "queued",
    working: status === "working",
    ended:
      status === "failed" || status === "stopped"
        ? {
            status,
            text:
              reason && reason in REASON_TEXT
                ? REASON_TEXT[reason as keyof typeof REASON_TEXT] ||
                  (status === "stopped" ? "Stopped." : "It did not finish.")
                : status === "stopped"
                  ? "Stopped."
                  : "It did not finish.",
          }
        : undefined,
    steps,
    segments,
    stepMoving: showsRunningStep(segmentItems[placed.length] ?? items),
    prompts,
    waiting: going && prompts.some((p) => !p.answered),
  };
}

/** The one line over the steps: what is happening, or how the work went. */
export function stepsLine(view: AgentView, elapsedMs?: number): string {
  return summarizeSteps(view.steps, elapsedMs);
}

/**
 * Whether the agent is on in a channel, as the channel says: a public channel has it unless a manager
 * switched it off, a private one only where a manager switched it on, and a direct message never.
 */
export function agentOnIn(channel: {
  kind?: string;
  visibility?: string;
  agent?: boolean;
}): boolean {
  if (channel.kind === "dm") return false;
  if (channel.kind === "personal") return true;
  return (channel.visibility ?? "public") === "public"
    ? channel.agent !== false
    : channel.agent === true;
}

/** Whether a message asks for the agent: it names it, as `@hive`. */
export const asksAgent = (text: string) => mentionsIn(text).includes("hive");
