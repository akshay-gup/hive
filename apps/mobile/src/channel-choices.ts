import {
  type JevAction,
  type JevPanel,
  jevActionPrefix,
  parseJevAction,
} from "../../../packages/domain/src/jev";
import { agentView } from "./chat-agent-extra";
import type { FeedMessage } from "./chat-feed";
import { parseJevResult } from "./jev-actions";

/** Where the choices the agent showed stand in a conversation kept by the chat service. */
export interface ChoiceState {
  /** The conversation the latest choices belong to. */
  threadId: string | null;
  /** The choices that may still be picked from: those shown after the person's last message. */
  latestPanelId: string | null;
  latestUserText: string | null;
  /** The option a pick was made for, once the agent has answered it. */
  confirmedSelection: (panelId: string) => string | null;
  /** The agent is answering, so nothing more can be picked yet. */
  busy: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The choice panels an agent's reply holds, in the order it showed them. */
export function panelsIn(extra: unknown): JevPanel[] {
  if (!isRecord(extra) || !Array.isArray(extra.steps)) return [];
  const asked = new Set<string>();
  const panels: JevPanel[] = [];
  for (const step of extra.steps) {
    if (!isRecord(step)) continue;
    if (step.role === "assistant" && Array.isArray(step.toolCalls)) {
      for (const call of step.toolCalls) {
        if (
          isRecord(call) &&
          typeof call.id === "string" &&
          isRecord(call.function) &&
          call.function.name === "present_choices"
        )
          asked.add(call.id);
      }
    } else if (
      step.role === "tool" &&
      typeof step.toolCallId === "string" &&
      asked.has(step.toolCallId)
    ) {
      const panel = parseJevResult(step.content)?.panel;
      if (panel) panels.push(panel);
    }
  }
  return panels;
}

/** A message's words without the mention that wakes the agent in a shared channel, where a pick needs one. */
const unmentioned = (body: string) => body.replace(/^@hive\s+/i, "");

/** Whether a message is a pick on the agent's choices. */
export const isPick = (body: string) => unmentioned(body).startsWith(jevActionPrefix);

function actionIn(body: string): JevAction | null {
  const text = unmentioned(body);
  if (!text.startsWith(jevActionPrefix)) return null;
  try {
    return parseJevAction(text.split("\n")[0] ?? text);
  } catch {
    return null;
  }
}

const fromAgent = (message: FeedMessage) => message.author.kind === "agent";

/** What a feed says about the choices in it. */
export function choiceState(messages: readonly FeedMessage[]): ChoiceState {
  let latest: JevPanel | null = null;
  let latestUserText: string | null = null;
  let busy = false;
  for (const message of messages) {
    if (!fromAgent(message)) {
      latest = null;
      latestUserText = message.body;
      continue;
    }
    const view = agentView(message.extra);
    if (view && (view.queued || view.working)) busy = true;
    const panels = panelsIn(message.extra);
    if (panels.length) latest = panels[panels.length - 1] ?? latest;
  }
  return {
    threadId: latest?.threadId ?? null,
    latestPanelId: latest?.id ?? null,
    latestUserText,
    busy,
    confirmedSelection: (panelId) => {
      for (let at = 0; at < messages.length; at++) {
        const message = messages[at] as FeedMessage;
        if (fromAgent(message)) continue;
        const action = actionIn(message.body);
        if (action?.panelId !== panelId) continue;
        const answered = messages
          .slice(at + 1)
          .some((later) => fromAgent(later) && later.body.trim() !== "");
        if (answered) return action.optionId;
      }
      return null;
    },
  };
}

/** What a message of the person's says in the conversation: a pick is shown as the choice it made. */
export function choiceLabel(messages: readonly FeedMessage[], at: number): string {
  const message = messages[at] as FeedMessage;
  if (fromAgent(message) || !isPick(message.body)) return message.body;
  const action = actionIn(message.body);
  if (!action) return "Choice unavailable";
  for (let earlier = at - 1; earlier >= 0; earlier--) {
    const found = panelsIn((messages[earlier] as FeedMessage).extra).find(
      (panel) => panel.id === action.panelId && panel.threadId === action.threadId,
    );
    const option = found?.options.find((candidate) => candidate.id === action.optionId);
    if (option) return `Selected: ${option.label}`;
  }
  return "Choice unavailable";
}

/** Whether the person has written since the agent message `id`, which is how a request for files is answered. */
export function answeredSince(messages: readonly FeedMessage[], id: string): boolean {
  const at = messages.findIndex((message) => message.id === id);
  return at >= 0 && messages.slice(at + 1).some((message) => !fromAgent(message));
}
