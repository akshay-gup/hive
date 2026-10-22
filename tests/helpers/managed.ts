import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { createStore } from "../../apps/server/src/db.ts";
import {
  generateWorkspaceKeys,
  signWorkspaceToken,
  type WorkspaceRole,
} from "../../packages/integrations/src/workspace-token.ts";

export interface TestPerson {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

/**
 * A workspace the control plane runs, with these people signed in: each comes in with a token the
 * control plane signed, so their role comes with them, and `call` speaks for any of them.
 */
export async function managedWorkspace<P extends Record<string, TestPerson>>(
  people: P,
  workspaceId = "wpeople",
) {
  type Who = keyof P & string;
  const keys = generateWorkspaceKeys();
  const directory = await mkdtemp(join(tmpdir(), "hive-people-"));
  const db = await createStore();
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: `https://${workspaceId}.example.test`,
    dataDir: directory,
    encryptionKey: randomBytes(32).toString("base64"),
    googleRedirectUri: `https://${workspaceId}.example.test/api/google/callback`,
    allowedOrigins: [],
    managed: { workspaceId, controlPublicKey: keys.publicKey },
  };
  const server = await createApp(db, config);
  const sessions = new Map<Who, string>();
  const signIn = async (who: Who) => {
    const person = people[who];
    const response = await server.app.request("/api/auth/managed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: signWorkspaceToken(keys.privateKey, {
          workspaceId,
          sub: person.id,
          email: person.email,
          name: person.name,
          role: person.role,
        }),
      }),
    });
    assert.equal(response.status, 200);
    sessions.set(who, (await response.json()).token);
  };
  for (const who of Object.keys(people) as Who[]) await signIn(who);
  return {
    server,
    db,
    directory,
    /** The id this workspace knows a person by. */
    owner: (who: Who) => `acct:${people[who].id}`,
    signIn,
    call: (who: Who, method: string, path: string, body?: unknown) =>
      server.app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${sessions.get(who)}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
