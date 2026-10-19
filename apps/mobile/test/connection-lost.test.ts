import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeLostConnection } from "../src/connection-lost";

test("errors from a workspace that went away are told apart from the agent failing", () => {
  for (const message of [
    "Failed to fetch",
    "Load failed",
    "TypeError: network error",
    "terminated",
    "HTTP 502: Bad gateway",
    "Request failed (503)",
    "The connection was closed",
    "ECONNRESET",
    "incomplete chunked encoding",
  ])
    assert.equal(looksLikeLostConnection(message), true, message);
  for (const message of [
    "The run timed out",
    "The run was cancelled",
    "The model is overloaded",
    "OpenCode task session.create failed",
    "Conversation could not be saved: disk full",
    "",
  ])
    assert.equal(looksLikeLostConnection(message), false, message);
});
