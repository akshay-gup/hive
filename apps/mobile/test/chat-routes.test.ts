import assert from "node:assert/strict";
import { test } from "node:test";
import { chatPathOf } from "../src/chat-routes.ts";

test("what the channel screens ask the workspace server is asked of the chat service", () => {
  const pairs: [string, string][] = [
    ["/api/agent/channels", "/v1/channels"],
    ["/api/agent/channels/design", "/v1/channels/design"],
    ["/api/agent/channels/design/members", "/v1/channels/design/members"],
    ["/api/agent/channels/design/managers", "/v1/channels/design/managers"],
    ["/api/agent/channels/design/archive", "/v1/channels/design/archive"],
    ["/api/agent/channels/design/mentionable", "/v1/channels/design/mentionable"],
    ["/api/agent/channels/design/read", "/v1/channels/design/read"],
    ["/api/agent/admin/channels", "/v1/admin/channels"],
    ["/api/agent/admin/channels/design/archive", "/v1/admin/channels/design/archive"],
    ["/api/agent/dms", "/v1/dms"],
    ["/api/agent/dms/people", "/v1/dms/people"],
    ["/api/agent/notification-prefs", "/v1/notification-prefs"],
    ["/chat/v1/channels/design/messages?limit=3", "/v1/channels/design/messages?limit=3"],
    // The board is the chat service's.
    ["/api/agent/tasks", "/v1/tasks"],
    ["/api/agent/tasks/t1", "/v1/tasks/t1"],
    ["/api/agent/tasks/t1/notes", "/v1/tasks/t1/notes"],
    ["/api/agent/tasks/t1/notes/n1", "/v1/tasks/t1/notes/n1"],
    ["/api/agent/tasks/t1/control", "/v1/tasks/t1/control"],
    ["/api/agent/tasks/t1/input", "/v1/tasks/t1/input"],
    ["/api/agent/projects", "/v1/projects"],
    ["/api/agent/projects/people", "/v1/projects/people"],
    ["/api/agent/projects/p1", "/v1/projects/p1"],
    ["/api/agent/ideas", "/v1/ideas"],
    ["/api/agent/ideas/i1", "/v1/ideas/i1"],
  ];
  for (const [from, to] of pairs) assert.equal(chatPathOf(from), to, from);
});

test("what belongs to the agent stays with the workspace server", () => {
  for (const path of [
    "/api/agent/channels/design/tasks",
    "/api/agent/channels/design/threads",
    "/api/agent/channels/design/files",
    "/api/agent/channels/design/files/info?path=a",
    "/api/agent/channels/design/uploads/req1",
    "/api/agent/threads/t1/channel",
    "/api/agent",
    "/api/agent/notifications",
    "/api/agent/ideas/refresh",
    "/api/workspace",
  ])
    assert.equal(chatPathOf(path), null, path);
});

test("what a channel holds, shown before it is deleted, is asked of the chat service", () => {
  assert.equal(chatPathOf("/api/agent/channels/abc/footprint"), "/v1/channels/abc/footprint");
});
