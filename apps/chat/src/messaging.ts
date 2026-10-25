import type { Access, Person } from "../../../packages/chat-core/src/access.ts";
import { isIn, managesChannel } from "../../../packages/chat-core/src/access.ts";
import { wantsAgent } from "../../../packages/chat-core/src/agent-trigger.ts";
import type { ChatChannels } from "../../../packages/chat-core/src/channels.ts";
import { AppError } from "../../../packages/chat-core/src/errors.ts";
import type { ChatEvent, Events } from "../../../packages/chat-core/src/events.ts";
import type { FileRow, Files } from "../../../packages/chat-core/src/files.ts";
import { MAX_BODY, type Message, type Messages } from "../../../packages/chat-core/src/messages.ts";
import type { Notice, Notifications } from "../../../packages/chat-core/src/notifications.ts";
import type { Reactions } from "../../../packages/chat-core/src/reactions.ts";
import type { Reads } from "../../../packages/chat-core/src/reads.ts";
import type { Run } from "../../../packages/chat-core/src/runs.ts";
import { SHARED_OWNER } from "../../../packages/chat-core/src/shared.ts";
import type { Sql } from "../../../packages/chat-core/src/sql.ts";
import type { RecordStore } from "../../../packages/chat-core/src/store.ts";
import type { Channel } from "../../../packages/domain/src/agent.ts";
import type {
  ChatMessage,
  ChatMessagePage,
  ChatNotice,
  ChatPerson,
  PostMessageInput,
} from "../../../packages/domain/src/chat.ts";
import { editMessageSchema, postMessageSchema } from "../../../packages/domain/src/chat.ts";
import type { AgentExtra } from "../../../packages/domain/src/chat-agent.ts";
import { mentionedPeople, withHandles } from "../../../packages/domain/src/mentions.ts";
import type { AgentLink } from "./agent-link.ts";

const fileView = (file: FileRow) => ({
  id: file.id,
  name: file.name,
  mime: file.mime,
  bytes: file.bytes,
  thumb: file.thumbReady,
  ...(file.width ? { width: file.width } : {}),
  ...(file.height ? { height: file.height } : {}),
});

type Known = Map<string, { email: string; name: string }>;

/** A line of what someone said, for a notice. */
const snippet = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
};

/**
 * What people say in channels: posting, editing, deleting, replying in threads and reacting, and
 * telling the people it is for. Every change is one transaction that also writes down the events that
 * keep other screens current; they are sent once it has gone through. Who may do what is decided here,
 * before anything is written.
 */
export class Messaging {
  constructor(
    private readonly deps: {
      sql: Sql;
      store: RecordStore;
      access: Access;
      channels: ChatChannels;
      messages: Messages;
      reactions: Reactions;
      files: Files;
      /** There is work for the bucket to do soon. */
      workQueued: () => void;
      reads: Reads;
      notices: Notifications;
      events: Events;
      publish: (event: ChatEvent) => void;
    },
  ) {}

  private agentLink: AgentLink | null = null;

  /** The agent, once it is made (it needs this to show its messages, and this needs it to start its runs). */
  useAgent(agent: AgentLink) {
    this.agentLink = agent;
  }

  private get db() {
    return this.deps.store;
  }

  /** Everyone messages are written by, as their names go: the people, and the agent under the name it gave. */
  async directory(): Promise<Known> {
    const known: Known = await this.deps.access.byId();
    const identity = await this.db.get<{ name?: string }>("system", "agent", "identity");
    known.set("agent", { email: "", name: identity?.name || "Hive" });
    return known;
  }

  /** The channel, if this person may open it: to anyone else there is no such channel. */
  private async open(owner: string, channelId: string): Promise<Channel> {
    await this.deps.access.assertChannel(owner, channelId);
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", channelId);
    if (!channel) throw new AppError("Channel not found", 404);
    return channel;
  }

  private async person(owner: string): Promise<Person> {
    const person = await this.deps.access.person(owner);
    if (!person?.email) throw new AppError("Chat needs a workspace that knows its people", 409);
    return person;
  }

  /** The people of a channel take part in it; a public channel is looked into and then joined. */
  private takePart(person: Person, channel: Channel) {
    if (channel.status === "archived") throw new AppError("This channel is archived", 409);
    if (!isIn(person, channel)) throw new AppError("Join the channel to take part in it", 403);
  }

  private personView(id: string, known: Known, kind: ChatPerson["kind"] = "person"): ChatPerson {
    const who = known.get(id);
    return { id, name: who?.name || who?.email || "Someone", email: who?.email ?? "", kind };
  }

  /** An agent's `extra` as the app is shown it: what the machine will answer with stays in the room. */
  private extraView(m: Message): unknown {
    const extra = m.extra as AgentExtra | null;
    if (m.authorKind !== "agent" || !extra?.prompts) return m.extra;
    return {
      ...extra,
      prompts: extra.prompts.map(({ requestId: _requestId, ...rest }) => rest),
    };
  }

  /** A message as the app is shown it. */
  async show(message: Message): Promise<ChatMessage> {
    return this.views([message], await this.directory())[0] as ChatMessage;
  }

  /** Messages as the app is shown them, with their reactions. */
  private views(messages: Message[], known: Known): ChatMessage[] {
    const reactions = this.deps.reactions.summary(messages.map((m) => m.id));
    const files = this.deps.files.ofMessages(messages.map((m) => m.id));
    return messages.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      seq: m.seq,
      author: this.personView(m.authorId, known, m.authorKind),
      body: m.body,
      threadRoot: m.threadRoot,
      replyCount: m.replyCount,
      lastReplyAt: m.lastReplyAt,
      replyPeople: m.replyUsers.map((id) => this.personView(id, known)),
      ...(m.clientId ? { clientId: m.clientId } : {}),
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deleted: m.deletedAt !== null,
      reactions: reactions.get(m.id) ?? [],
      files: (files.get(m.id) ?? []).map(fileView),
      ...(m.extra ? { extra: this.extraView(m) } : {}),
    }));
  }

  private emit(
    sent: ChatEvent[],
    type: string,
    data: unknown,
    scope: { channelId?: string | null; userId?: string | null },
  ) {
    sent.push(this.deps.events.append(type, data, scope));
  }

  private send(sent: ChatEvent[]) {
    for (const event of sent) this.deps.publish(event);
  }

  async page(
    owner: string,
    channelId: string,
    options: { before?: number; limit?: number },
  ): Promise<ChatMessagePage> {
    await this.open(owner, channelId);
    const { messages, more } = this.deps.messages.page(channelId, options);
    return { messages: this.views(messages, await this.directory()), more };
  }

  async replies(
    owner: string,
    messageId: string,
    options: { after?: number; limit?: number },
  ): Promise<{ root: ChatMessage; replies: ChatMessage[] }> {
    const root = this.deps.messages.get(messageId);
    if (!root) throw new AppError("Message not found", 404);
    await this.open(owner, root.channelId);
    const known = await this.directory();
    return {
      root: this.views([root], known)[0] as ChatMessage,
      replies: this.views(this.deps.messages.replies(messageId, options), known),
    };
  }

  async threads(owner: string, channelId: string): Promise<ChatMessage[]> {
    await this.open(owner, channelId);
    return this.views(this.deps.messages.threads(channelId), await this.directory());
  }

  /** What was written in the channel after a place, thread replies too, for a client that was away. */
  async since(owner: string, channelId: string, seq: number): Promise<ChatMessage[]> {
    await this.open(owner, channelId);
    return this.views(this.deps.messages.since(channelId, seq), await this.directory());
  }

  async post(owner: string, channelId: string, raw: unknown): Promise<ChatMessage> {
    const input: PostMessageInput = postMessageSchema.parse(raw);
    const person = await this.person(owner);
    const channel = await this.open(owner, channelId);
    this.takePart(person, channel);
    const text = input.body.trim();
    const fileIds = input.fileIds ?? [];
    if (!text && fileIds.length === 0) throw new AppError("Write something to send", 422);
    if (text.length > MAX_BODY) throw new AppError("That message is too long", 422);

    const known = await this.directory();
    // Only people who may open the channel are told about it, so a mention cannot tell someone a private channel exists.
    const openers =
      text.includes("@") || input.threadRoot ? await this.deps.access.openers(channel) : [];
    const mentioned = text.includes("@")
      ? mentionedPeople(text, withHandles(openers)).filter((who) => who.email !== person.email)
      : [];
    const idOfEmail = new Map(openers.map((o) => [o.email, o.owner]));
    const sent: ChatEvent[] = [];

    const view = this.deps.sql.transaction(() => {
      const { message, created } = this.deps.messages.post({
        channelId,
        authorId: owner,
        body: text,
        threadRoot: input.threadRoot ?? null,
        clientId: input.clientId ?? null,
      });
      if (created && fileIds.length > 0)
        this.deps.files.attach(fileIds, message.id, channelId, owner);
      const [made] = this.views([message], known) as [ChatMessage];
      if (!created) return made;
      // Having written it, you have read as far as it.
      this.deps.reads.mark(owner, channelId, message.seq);
      const told = new Set<string>();
      const tell = (userId: string | undefined, kind: "mention" | "reply") => {
        if (!userId || userId === owner || told.has(userId)) return;
        if (
          !this.deps.notices.add({
            userId,
            kind,
            messageId: message.id,
            channelId,
            seq: message.seq,
          })
        )
          return;
        told.add(userId);
        this.emit(sent, "notification.new", this.noticeView(channel, message, kind, known), {
          userId,
          channelId,
        });
      };
      for (const who of mentioned) tell(idOfEmail.get(who.email), "mention");
      if (message.threadRoot) {
        const root = this.deps.messages.get(message.threadRoot);
        if (root) {
          tell(root.authorId, "reply");
          for (const id of root.replyUsers) tell(id, "reply");
        }
      }
      this.emit(sent, "message.new", made, { channelId });
      // A mention of the agent makes its reply, and the run that writes it, with the message that asked.
      const asked =
        this.agentLink && wantsAgent(text)
          ? this.agentLink.trigger({ channel, trigger: message, asker: person })
          : null;
      if (asked) this.emit(sent, "message.new", this.views([asked.reply], known)[0], { channelId });
      const rootId = message.threadRoot ?? (asked ? message.id : null);
      if (rootId) {
        const root = this.deps.messages.get(rootId);
        if (root) this.emit(sent, "thread.updated", this.views([root], known)[0], { channelId });
      }
      this.emit(
        sent,
        "read.updated",
        { channelId, seq: message.seq },
        { userId: owner, channelId },
      );
      return made;
    });
    this.send(sent);
    // The run goes to the agent's machine, or the machine is woken.
    if (this.agentLink && wantsAgent(text)) {
      await this.agentLink.pump();
      // The room looks at the run again soon, whatever the machine does.
      this.deps.workQueued();
    }
    return view;
  }

  async edit(owner: string, messageId: string, raw: unknown): Promise<ChatMessage> {
    const { body } = editMessageSchema.parse(raw);
    const found = this.deps.messages.get(messageId);
    if (!found) throw new AppError("Message not found", 404);
    const person = await this.person(owner);
    const channel = await this.open(owner, found.channelId);
    this.takePart(person, channel);
    const text = body.trim();
    if (!text) throw new AppError("A message cannot be emptied; delete it instead", 422);
    const known = await this.directory();
    const sent: ChatEvent[] = [];
    const view = this.deps.sql.transaction(() => {
      const [edited] = this.views([this.deps.messages.edit(messageId, owner, text)], known) as [
        ChatMessage,
      ];
      this.emit(sent, "message.edited", edited, { channelId: found.channelId });
      return edited;
    });
    this.send(sent);
    return view;
  }

  /** A message goes when its author, a manager of the channel, or the owner or an admin who can open it takes it away. */
  async remove(owner: string, messageId: string): Promise<{ ok: true }> {
    const found = this.deps.messages.get(messageId);
    if (!found) throw new AppError("Message not found", 404);
    const person = await this.person(owner);
    const channel = await this.open(owner, found.channelId);
    if (channel.status === "archived") throw new AppError("This channel is archived", 409);
    if (found.authorId !== owner && !managesChannel(person, channel))
      throw new AppError(
        "Only its author, a channel manager, an admin or the owner can delete a message",
        403,
      );
    const known = await this.directory();
    const sent: ChatEvent[] = [];
    let queued = false;
    this.deps.sql.transaction(() => {
      const gone = this.deps.messages.remove(messageId);
      if (!gone) return;
      this.deps.notices.removeForMessage(messageId);
      if (this.deps.files.removeOfMessage(messageId) > 0) queued = true;
      this.emit(
        sent,
        "message.deleted",
        { id: messageId, channelId: found.channelId, threadRoot: found.threadRoot },
        { channelId: found.channelId },
      );
      if (found.threadRoot) {
        const root = this.deps.messages.get(found.threadRoot);
        if (root)
          this.emit(sent, "thread.updated", this.views([root], known)[0], {
            channelId: found.channelId,
          });
      }
    });
    if (queued) this.deps.workQueued();
    this.send(sent);
    await this.agentLink?.messageGone(messageId);
    return { ok: true };
  }

  async react(owner: string, messageId: string, emoji: string, on: boolean): Promise<ChatMessage> {
    const found = this.deps.messages.get(messageId);
    if (!found || found.deletedAt) throw new AppError("Message not found", 404);
    const person = await this.person(owner);
    const channel = await this.open(owner, found.channelId);
    this.takePart(person, channel);
    const known = await this.directory();
    const sent: ChatEvent[] = [];
    const view = this.deps.sql.transaction(() => {
      const changed = on
        ? this.deps.reactions.add(messageId, found.channelId, owner, emoji)
        : this.deps.reactions.remove(messageId, owner, emoji);
      const [now] = this.views([found], known) as [ChatMessage];
      if (changed)
        this.emit(
          sent,
          "reaction.set",
          { messageId, channelId: found.channelId, reactions: now.reactions },
          { channelId: found.channelId },
        );
      return now;
    });
    this.send(sent);
    return view;
  }

  /** A message changed in a way only its screens show (a file left it): they are told. */
  async refresh(messageId: string): Promise<void> {
    const message = this.deps.messages.get(messageId);
    if (!message || message.deletedAt) return;
    const sent: ChatEvent[] = [];
    this.emit(sent, "message.edited", this.views([message], await this.directory())[0], {
      channelId: message.channelId,
    });
    this.send(sent);
  }

  /** The person who asked the agent is told it has answered, unless they can no longer open the channel or have muted it. */
  async runEnded(run: Run, reply: Message): Promise<void> {
    const prefs = await this.deps.channels.notificationPrefs(run.askedBy);
    const scope = await this.deps.access.scope(run.askedBy);
    if (prefs.muted.includes(run.channelId) || !scope.allows(run.channelId)) return;
    const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", run.channelId);
    if (!channel) return;
    const sent: ChatEvent[] = [];
    const added = this.deps.notices.add({
      userId: run.askedBy,
      kind: "reply",
      messageId: reply.id,
      channelId: run.channelId,
      seq: reply.seq,
    });
    if (added)
      this.emit(
        sent,
        "notification.new",
        this.noticeView(channel, reply, "reply", await this.directory()),
        { userId: run.askedBy, channelId: run.channelId },
      );
    this.send(sent);
  }

  /** The person has read a channel up to a place: their other screens are told. */
  async markRead(owner: string, channelId: string, seq?: number): Promise<number> {
    const at = await this.deps.channels.markRead(owner, channelId, seq);
    const sent: ChatEvent[] = [];
    this.emit(sent, "read.updated", { channelId, seq: at }, { userId: owner, channelId });
    this.send(sent);
    return at;
  }

  // What the person is told

  private noticeView(
    channel: Channel,
    message: Message,
    kind: "mention" | "reply",
    known: Known,
    read = false,
  ): ChatNotice {
    const by = known.get(message.authorId);
    const name = by?.name || by?.email || "Someone";
    const where = channel.kind === "dm" ? "a direct message" : `#${channel.name}`;
    return {
      id: message.id,
      kind,
      channelId: channel.id,
      channelName: channel.name,
      by: by?.email ?? "",
      byName: name,
      title:
        kind === "mention" ? `${name} mentioned you in ${where}` : `${name} replied in ${where}`,
      body: snippet(message.body),
      createdAt: message.createdAt,
      read,
    };
  }

  /** The notices this person is to be shown: not those of a channel they have muted or have turned off, and none of a channel they can no longer open. */
  async notices(owner: string, options: { unreadOnly?: boolean } = {}): Promise<ChatNotice[]> {
    const prefs = await this.deps.channels.notificationPrefs(owner);
    const scope = await this.deps.access.scope(owner);
    const known = await this.directory();
    const out: ChatNotice[] = [];
    for (const notice of this.deps.notices.list(owner, { unreadOnly: options.unreadOnly })) {
      if (prefs.muted.includes(notice.channelId) || !scope.allows(notice.channelId)) continue;
      if (!prefs.mentions) continue;
      const message = this.deps.messages.get(notice.messageId);
      const channel = await this.db.get<Channel>(SHARED_OWNER, "channels", notice.channelId);
      if (!message || !channel || message.deletedAt) continue;
      out.push(
        this.noticeView(
          channel,
          message,
          notice.kind as "mention" | "reply",
          known,
          notice.readAt !== null,
        ),
      );
    }
    return out;
  }

  noticeState(owner: string, action: "read" | "unread" | "dismiss", ids?: string[]): number {
    const sent: ChatEvent[] = [];
    const changed =
      action === "read"
        ? this.deps.notices.markRead(owner, ids)
        : action === "unread"
          ? this.deps.notices.markUnread(owner, ids ?? [])
          : this.deps.notices.dismiss(owner, ids);
    if (changed > 0)
      this.emit(sent, "notification.changed", { action, ids: ids ?? null }, { userId: owner });
    this.send(sent);
    return changed;
  }
}

export type { Notice };
