import type { Plan } from "./plans.ts";

/** What a workspace is created from. */
export interface WorkspaceSpec {
  workspaceId: string;
  name: string;
  plan: Plan;
  /** Where to run it, as the provider names regions. Left out, the provider's default. */
  region?: string;
  /** Base64url DER (SPKI) of the key the workspace checks people's tokens against. */
  controlPublicKey: string;
  /** Web origins that may call the workspace's API from a browser: the control plane's own web app. */
  allowedOrigins: string[];
}

export interface ProvisionedWorkspace {
  /** Where the apps reach the workspace: an https origin, no trailing slash. */
  url: string;
}

export type MachineState = "running" | "starting" | "stopped" | "missing";

/** Where making a workspace has got to, in the order a provider goes through it. */
export const provisionSteps = ["address", "machine", "starting", "checking"] as const;
export type ProvisionStep = (typeof provisionSteps)[number];
/**
 * Told as `create` moves on to a step, so the person watching can see it. A provider that has no
 * such steps never calls it, and a step it skips (no address to make) is shown as done.
 */
export type ProvisionProgress = (step: ProvisionStep) => void;

/**
 * Where workspaces run. A workspace is named by its id throughout, and every call can be made
 * again: creating one that half exists finishes it, and destroying one that is gone is not an error.
 */
export interface Provisioner {
  readonly name: string;
  /** Create what the workspace runs on and start it. Resolves once it answers its health check. */
  create(spec: WorkspaceSpec, progress?: ProvisionProgress): Promise<ProvisionedWorkspace>;
  /** Start the workspace if it was stopped, and resolve once it answers. */
  wake(workspaceId: string): Promise<void>;
  state(workspaceId: string): Promise<MachineState>;
  /** Remove the workspace and its data. */
  destroy(workspaceId: string): Promise<void>;
  /**
   * Where something the host does not route for us, such as the edge, connects to reach the
   * workspace: an http origin on the host's own network, or null when it is not running. Hosts
   * whose public address reaches the workspace itself have none.
   */
  upstream?(workspaceId: string): Promise<string | null>;
  /** Let go of what the provisioner itself holds (processes it started, say) when the control plane stops. */
  close?(): Promise<void>;
}

/** A provisioning failure, with what to tell the person, apart from what the logs get. */
export class ProvisionError extends Error {
  constructor(
    message: string,
    readonly userMessage = "We could not start this workspace. Try again in a minute.",
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
