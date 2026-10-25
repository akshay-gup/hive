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
  if (!isRecord(extra) || extra.v !== 1 || typeof extra.runId !== "string") return null;
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
  // The agent's own cards (mail, choices) are not offered in a channel; one that shows up is only a step.
  const items = mergeItems(progressItems(calls, results as never[], going));
  const steps = items.flatMap((item) => (item.kind === "steps" ? item.steps : []));
  const prompts = (Array.isArray(extra.prompts) ? (extra.prompts as PromptState[]) : [])
    .filter((p) => isRecord(p) && isRecord(p.prompt) && typeof p.prompt.id === "string")
    .sort((a, b) => Number(!!a.answered) - Number(!!b.answered));
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
    stepMoving: showsRunningStep(items),
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
  return (channel.visibility ?? "public") === "public"
    ? channel.agent !== false
    : channel.agent === true;
}

/** Whether a message asks for the agent: it names it, as `@hive`. */
export const asksAgent = (text: string) => mentionsIn(text).includes("hive");
