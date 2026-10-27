import { type AgentTask, taskBriefLimits } from "../../../../packages/domain/src/agent.ts";
import type { TaskFiles } from "../engine/task-files.ts";
import { inspectAttachment } from "../engine/task-files.ts";
import type { Files } from "../files.ts";

type Attachment = NonNullable<AgentTask["attachments"]>[number];

/**
 * The files of a task the machine borrows. The chat service keeps them; while the machine works the task it
 * fetches each from the address the room gave, checks it is what its name says, and keeps it where a run
 * finds it (the same place a task's files were always kept). When the task goes back, so do they: nothing
 * of a task's files stays on the machine.
 */
export class BorrowedFiles {
  constructor(
    private readonly deps: {
      taskFiles: TaskFiles;
      files: Files;
      /** The address of the chat service, to fetch a file's path from. */
      origin: () => string | null;
      /** Where a task's staged files are, for clearing them. */
      workspaceOf: (task: AgentTask, owner: string) => string;
      fetcher?: typeof fetch;
      log?: (line: string) => void;
    },
  ) {}

  /** Fetch these files and keep the ones that are good; they come back without an address. */
  async take(owner: string, taskId: string, files: Attachment[]): Promise<Attachment[]> {
    const origin = this.deps.origin();
    const kept: Attachment[] = [];
    for (const file of files) {
      const { url, ...rest } = file;
      if (!url || !origin) continue;
      try {
        const response = await (this.deps.fetcher ?? fetch)(`${origin}${url}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`the chat service said ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > taskBriefLimits.attachmentBytes) throw new Error("it is too big");
        // The room cannot read the bytes (they go to the bucket): they are checked here, before the agent sees them.
        inspectAttachment(file.name, bytes);
        await this.deps.taskFiles.save(taskId, file.id, bytes).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        const attachment: Attachment = { ...rest };
        // A PDF is also kept in Files, which the agent's PDF tools read.
        if (file.mimeType === "application/pdf")
          attachment.fileId = (
            await this.deps.files.import(owner, file.name, bytes, "Attached to a task")
          ).id;
        kept.push(attachment);
      } catch (error) {
        this.deps.log?.(`[chat-runner] a file of task ${taskId} was left out: ${String(error)}`);
      }
    }
    return kept;
  }

  /** The task is given back: its files go from the machine. */
  async drop(owner: string, task: AgentTask) {
    for (const file of task.attachments ?? [])
      if (file.fileId) await this.deps.files.discard(owner, file.fileId).catch(() => undefined);
    await this.deps.taskFiles
      .removeAll(task.id, this.deps.workspaceOf(task, owner))
      .catch(() => undefined);
  }
}
