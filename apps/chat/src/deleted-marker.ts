/** What the marker needs of a Durable Object's storage. */
export interface MarkerStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

const KEY = "deleted-at";
/** A token lasts about an hour, so after two a marker has nothing left to refuse. */
export const KEEP_DELETED_MS = 2 * 60 * 60 * 1000;

/**
 * What is left of a workspace's room once it is deleted and everything else is wiped: when it was.
 * While it is there the room answers nothing, so a sign-in made before the delete cannot start an
 * empty room in its place. When it has done its work, an alarm clears it, and the room is empty.
 */
export class DeletedMarker {
  constructor(
    private readonly storage: MarkerStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  async deleted(): Promise<boolean> {
    return (await this.storage.get<number>(KEY)) !== undefined;
  }

  /** Wipe the room and leave the marker, with the time of the first delete (a second changes nothing). */
  async wipe(clearOthers: () => Promise<void> = async () => undefined): Promise<void> {
    const at = (await this.storage.get<number>(KEY)) ?? this.clock();
    await this.storage.deleteAll();
    await clearOthers();
    await this.storage.put(KEY, at);
    await this.storage.setAlarm(at + KEEP_DELETED_MS);
  }

  /** The alarm went off: clear the marker if its time is up, or ask again for when it is. Whether there was a marker. */
  async upkeep(): Promise<boolean> {
    const at = await this.storage.get<number>(KEY);
    if (at === undefined) return false;
    if (this.clock() >= at + KEEP_DELETED_MS) await this.storage.deleteAll();
    else await this.storage.setAlarm(at + KEEP_DELETED_MS);
    return true;
  }
}
