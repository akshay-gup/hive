import type { RunnerLink } from "../../apps/chat/src/agent-link.ts";
import { ChatCore, type ChatIdentity } from "../../apps/chat/src/core.ts";
import type { ChatEvent } from "../../packages/chat-core/src/events.ts";
import type { WorkspaceRole } from "../../packages/integrations/src/workspace-token.ts";
import { memorySql } from "./do-shim.ts";

export interface TestPerson {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

/**
 * A workspace's chat on Node's SQLite, with these people in it (the control plane has told it who
 * they are) and everything it publishes kept for the test to look at. `call` speaks for any of them.
 */
export async function chatWorld<P extends Record<string, TestPerson>>(
  people: P,
  options: {
    limits?: ChatIdentity["limits"];
    clock?: () => number;
    /** The agent's machine, if the test has one: what the room sends it goes here. */
    runner?: () => RunnerLink | null;
    /** The key and workspace the room signs addresses and tickets with. */
    link?: { key: string; workspaceId: string };
  } = {},
) {
  type Who = keyof P & string;
  const published: ChatEvent[] = [];
  const core = new ChatCore(memorySql(), {
    publish: (event) => published.push(event),
    clock: options.clock,
    runner: options.runner,
    ...(options.link
      ? { linkKey: () => options.link?.key, workspaceId: () => options.link?.workspaceId ?? null }
      : {}),
  });
  await core.syncPeople(
    Object.values(people).map((p) => ({ sub: p.id, email: p.email, name: p.name, role: p.role })),
  );
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const person = people[who] as TestPerson;
    return core.handle(
      new Request(`http://chat${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {
        sub: person.id,
        email: person.email,
        name: person.name,
        role: person.role,
        issuedAt: Date.now(),
        limits: options.limits,
      },
    );
  };
  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  return { core, call, ok, published, people };
}
