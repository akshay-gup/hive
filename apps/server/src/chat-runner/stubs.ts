import { SHARED_OWNER } from "../../../../packages/chat-core/src/shared.ts";
import type { Channel, ChannelThread } from "../../../../packages/domain/src/agent.ts";
import type { RunStart } from "../../../../packages/domain/src/chat-agent.ts";
import type { AgentService } from "../engine/service.ts";

/** The thread a mention's conversation is, by the message it hangs from. Safe as a file name. */
export const threadIdFor = (rootId: string) => `chat-${rootId.replace(/[^A-Za-z0-9-]/g, "-")}`;

/** The person the chat service vouches for, so what the tools do is done as them. */
export async function vouchFor(
  service: AgentService,
  person: { id: string; email: string; name: string; role: string },
): Promise<void> {
  const known = await service.db.get<{ id: string }>("system", "users", person.id);
  const asker = {
    ...(known ?? {}),
    id: person.id,
    email: person.email.toLowerCase(),
    name: person.name,
    role: person.role,
  };
  if (JSON.stringify(known) !== JSON.stringify(asker))
    await service.db.put("system", "users", asker);
}

/**
 * What the agent's machine keeps of a channel it was mentioned in, so its session and its working folder
 * have somewhere to be: a record with the channel's id and name and, for a private one, no members. Who
 * is in a channel is the chat service's to know and is never told to this machine (anyone holding root
 * here could read it), so a private stub opens to no one. Board lookups go to the chat service, which
 * knows the real audience; the stub grants no access to local records.
 */
export async function standInFor(
  service: AgentService,
  home: { id: string; name: string; topic: string; visibility: "public" | "private" },
): Promise<Channel> {
  const now = new Date().toISOString();
  const wanted = {
    name: home.name,
    topic: home.topic || undefined,
    visibility: home.visibility,
  };
  const existing = await service.db.get<Channel>(SHARED_OWNER, "channels", home.id);
  if (!existing) {
    const channel: Channel = {
      id: home.id,
      name: wanted.name,
      status: "active",
      createdBy: "chat",
      createdAt: now,
      updatedAt: now,
      workerPid: null,
      lastActiveAt: now,
      visibility: wanted.visibility,
      everyone: wanted.visibility === "public",
      members: [],
      ...(wanted.topic ? { topic: wanted.topic } : {}),
    };
    await service.db.insertIfAbsent(SHARED_OWNER, "channels", channel);
    return channel;
  }
  if (
    existing.name !== wanted.name ||
    existing.visibility !== wanted.visibility ||
    existing.topic !== wanted.topic ||
    existing.status !== "active"
  ) {
    const channel = { ...existing, ...wanted, status: "active" as const, updatedAt: now };
    await service.db.put(SHARED_OWNER, "channels", channel);
    return channel;
  }
  return existing;
}

export async function prepareRun(
  service: AgentService,
  start: RunStart,
): Promise<{ binding: ChannelThread; channel: Channel }> {
  const now = new Date().toISOString();
  const channel = await standInFor(service, start.channel);
  await vouchFor(service, start.asker);

  const threadId = threadIdFor(start.thread.rootId);
  // Read from where it is kept: the lookup by thread remembers for a few seconds that it found none.
  const bound = (await service.threads.list(start.asker.id, start.channel.id)).find(
    (b) => b.threadId === threadId,
  );
  if (bound) {
    if (bound.boardAccessKey !== start.boardAccessKey) {
      const { opencodeSessionId: _session, ...fresh } = bound;
      const binding = { ...fresh, boardAccessKey: start.boardAccessKey };
      await service.threads.write(start.asker.id, binding);
      return { binding, channel };
    }
    return { binding: bound, channel };
  }
  const binding: ChannelThread = {
    threadId,
    channelId: start.channel.id,
    name: `${start.channel.name} thread`.slice(0, 80),
    createdAt: now,
    parentMessageId: start.thread.rootId,
    boardAccessKey: start.boardAccessKey,
  };
  await service.threads.write(start.asker.id, binding);
  return { binding, channel };
}
