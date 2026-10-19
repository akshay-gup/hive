import { HttpError } from "./errors.ts";
import type { ControlStore } from "./store.ts";

const OWNER = "control";
const KIND = "releases";
const DEFAULT_ID = "default";
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A build of the workspace: the image tag, and its digest, which says exactly which build the tag is. */
export interface Build {
  tag: string;
  digest: string;
}

interface Stored extends Build {
  id: string;
  updatedAt: string;
}
interface DefaultRecord extends Stored {
  /** While paused, machines that have no build of their own are told nothing, so none of them moves. */
  paused: boolean;
}

/** The answer a workspace's machine gets: a build to be on, or nothing, which means stay as it is. */
export type Wanted = { tag: string; digest: string; force: boolean } | Record<string, never>;

export function checkBuild(build: Partial<Build>): Build {
  if (typeof build.tag !== "string" || !TAG.test(build.tag))
    throw new HttpError("The tag is not usable", 422);
  if (typeof build.digest !== "string" || !DIGEST.test(build.digest))
    throw new HttpError("The digest must be sha256: and 64 hex characters", 422);
  return { tag: build.tag, digest: build.digest };
}

/**
 * Which build of the workspace each workspace should run. There is one for everyone (what a push to
 * main publishes), which can be paused, and a workspace can have a build of its own that is not moved
 * by it: an operator's own workspace to try a build on first, or one held back.
 */
export class Releases {
  constructor(private readonly db: ControlStore) {}

  private async current(): Promise<DefaultRecord | null> {
    return this.db.get<DefaultRecord>(OWNER, KIND, DEFAULT_ID);
  }
  private pinKey = (workspaceId: string) => `pin:${workspaceId}`;

  /** What a machine is told. A pin counts even while everyone else is paused. */
  async wantedFor(workspaceId: string): Promise<Wanted> {
    const pin = await this.db.get<Stored>(OWNER, KIND, this.pinKey(workspaceId));
    if (pin) return { tag: pin.tag, digest: pin.digest, force: false };
    const current = await this.current();
    if (!current || current.paused) return {};
    return { tag: current.tag, digest: current.digest, force: false };
  }

  /** What is published for everyone. Pausing is kept across a new build, so a pause is not undone by a push. */
  async publish(build: Partial<Build>): Promise<DefaultRecord> {
    const checked = checkBuild(build);
    const was = await this.current();
    const record: DefaultRecord = {
      id: DEFAULT_ID,
      ...checked,
      paused: was?.paused ?? false,
      updatedAt: new Date().toISOString(),
    };
    return this.db.put(OWNER, KIND, record);
  }

  async pause(paused: boolean): Promise<DefaultRecord> {
    const was = await this.current();
    if (!was) throw new HttpError("No build has been published yet", 409);
    return this.db.put(OWNER, KIND, { ...was, paused, updatedAt: new Date().toISOString() });
  }

  async pin(workspaceId: string, build: Partial<Build>): Promise<Stored> {
    const checked = checkBuild(build);
    return this.db.put(OWNER, KIND, {
      id: this.pinKey(workspaceId),
      ...checked,
      updatedAt: new Date().toISOString(),
    });
  }

  async unpin(workspaceId: string): Promise<void> {
    await this.db.remove(OWNER, KIND, this.pinKey(workspaceId));
  }

  async overview(): Promise<{ default: DefaultRecord | null; pins: Stored[] }> {
    const all = await this.db.list<Stored>(OWNER, KIND);
    return {
      default: await this.current(),
      pins: all.filter((item) => item.id.startsWith("pin:")),
    };
  }
}
