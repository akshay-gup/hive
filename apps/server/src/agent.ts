import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Config } from "./config.ts";

export function makeRuntime(config: Config) {
  // The agent is OpenCode, reached through the AG-UI shim in this process. The caller's auth is
  // forwarded so the shim route resolves the owner the same way this request did.
  const agents: AgentsFactory = async ({ request }) => {
    const authorization = request.headers.get("authorization") ?? undefined;
    return {
      default: new HttpAgent({
        url: `${config.publicUrl}/api/agent/opencode/run`,
        headers: authorization ? { authorization } : {},
      }),
    };
  };
  const runtime = new CopilotRuntime({ agents });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
