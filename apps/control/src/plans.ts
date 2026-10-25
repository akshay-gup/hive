export type PlanId = "free" | "team";

export interface Plan {
  id: PlanId;
  label: string;
  /** The machine a workspace runs on. */
  guest: { cpuKind: "shared" | "performance"; cpus: number; memoryMb: number };
  /** Disk for the workspace's database, files and browser profiles, in GB. */
  volumeGb: number;
  /** Stop the machine when nobody is using it, and start it again on the next request. */
  stopsWhenIdle: boolean;
  /** The most one file sent in chat may be, in bytes. */
  maxFileBytes: number;
  /** The most all of a workspace's files in chat may be, in bytes. */
  storageBytes: number;
}

/**
 * What each plan gets. Nothing bills yet, so every workspace is `free`; the sizes are the place to
 * start from, and `team` is the same machine kept running.
 */
export const plans: Record<PlanId, Plan> = {
  free: {
    id: "free",
    label: "Free",
    guest: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
    volumeGb: 5,
    stopsWhenIdle: true,
    maxFileBytes: 25 * 1024 ** 2,
    storageBytes: 10 * 1024 ** 3,
  },
  team: {
    id: "team",
    label: "Team",
    guest: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
    volumeGb: 20,
    stopsWhenIdle: false,
    maxFileBytes: 100 * 1024 ** 2,
    storageBytes: 100 * 1024 ** 3,
  },
};

export const DEFAULT_PLAN: PlanId = "free";
