import type {
  MachineState,
  ProvisionedWorkspace,
  Provisioner,
  ProvisionProgress,
  ProvisionStep,
  WorkspaceSpec,
} from "../../apps/control/src/provisioner.ts";
import { ProvisionError } from "../../apps/control/src/provisioner.ts";

/**
 * Where workspaces would run, kept in memory: it records what it was asked, answers with an
 * address, and fails when told to, so the control plane can be tested without a cloud.
 */
export class FakeProvisioner implements Provisioner {
  readonly name = "fake";
  readonly created: WorkspaceSpec[] = [];
  readonly woken: string[] = [];
  readonly destroyed: string[] = [];
  /** The workspaces whose address was asked for. */
  readonly upstreamAsked: string[] = [];
  /** Fail the next `create` this many times. */
  failCreates = 0;
  failDestroys = 0;
  /** Resolves a create only when released, to look at a workspace while it is being made. */
  hold?: Promise<void>;
  /** The steps a create reports before it waits on `hold`. */
  reportSteps: ProvisionStep[] = [];
  private readonly machines = new Map<string, MachineState>();

  async create(spec: WorkspaceSpec, progress?: ProvisionProgress): Promise<ProvisionedWorkspace> {
    this.created.push(spec);
    for (const step of this.reportSteps) progress?.(step);
    if (this.hold) await this.hold;
    if (this.failCreates > 0) {
      this.failCreates--;
      throw new ProvisionError("the provider said no", "We could not start this workspace.");
    }
    this.machines.set(spec.workspaceId, "running");
    return { url: `https://${spec.workspaceId}.fake.test` };
  }
  async wake(workspaceId: string) {
    this.woken.push(workspaceId);
    this.machines.set(workspaceId, "running");
  }
  async state(workspaceId: string): Promise<MachineState> {
    return this.machines.get(workspaceId) ?? "missing";
  }
  async upstream(workspaceId: string): Promise<string | null> {
    this.upstreamAsked.push(workspaceId);
    return this.machines.get(workspaceId) === "running"
      ? `http://${workspaceId}.upstream.test:8787`
      : null;
  }
  /** What the provider reports when the machine was stopped to save money. */
  stop(workspaceId: string) {
    this.machines.set(workspaceId, "stopped");
  }
  async destroy(workspaceId: string) {
    if (this.failDestroys > 0) {
      this.failDestroys--;
      throw new Error("the provider could not remove it");
    }
    this.destroyed.push(workspaceId);
    this.machines.delete(workspaceId);
  }
}
