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
  /** Which model the agent runs on and how it reaches it (see `ModelGateway.environmentFor`), when the control plane keeps the key. */
  modelEnv?: Record<string, string>;
  /** Where the machine asks which build it should run (`/v1/release/<id>` on the control plane), for a provider whose machines update themselves. */
  updateUrl?: string;
  /** The build the machine is to be running (an image tag): it is not ready until it is on it. */
  build?: string;
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
  /**
   * Upkeep the provider needs from time to time, called every minute by the control plane's timer
   * (copying the workspace image to the regions a workspace may fall back to, say). It must be
   * cheap when there is nothing to do, and a failure is for the logs: it never stops anything else.
   */
  maintain?(): Promise<void>;
  /** Let go of what the provisioner itself holds (processes it started, say) when the control plane stops. */
  close?(): Promise<void>;
}

/** A provisioning failure, with what to tell the person, apart from what the logs get. */
export class ProvisionError extends Error {
  constructor(
    message: string,
    readonly userMessage = "We could not start this workspace. Try again in a minute.",
    /** The provider has no room for it right now, which time may mend: worth trying again for a while. */
    readonly capacity = false,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
