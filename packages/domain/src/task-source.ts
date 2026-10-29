/** A project choice is private to the person creating the task, even when its card is in a channel. */
export interface SourceTaskView {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  status: "pending" | "created" | "cancelled";
  taskId?: string;
  suggestedProjectId?: string;
  projects: { id: string; name: string; access: "open" | "limited" | "private" }[];
}

export interface SourceTaskAudience {
  projectId: string;
  projectName: string;
  fingerprint: string;
  confirmed: boolean;
  outside: { id: string; name: string; email: string }[];
}
