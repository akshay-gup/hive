import {
  GENERAL_PROJECT_ID,
  type ProjectAccess,
  type ProjectRole,
} from "../../../packages/domain/src/agent";

/** What each way a project can be open means, in the words the person chooses by. */
export const accessChoices: { id: ProjectAccess; title: string; detail: string }[] = [
  {
    id: "open",
    title: "Open",
    detail: "Everyone in the workspace can see it and work on its tasks.",
  },
  {
    id: "limited",
    title: "Limited",
    detail: "Everyone can see it. Only the people you add can work on its tasks.",
  },
  {
    id: "private",
    title: "Private",
    detail: "Only the people you add can see it or its tasks.",
  },
];

export const roleChoices: { id: ProjectRole; title: string; detail: string }[] = [
  { id: "admin", title: "Admin", detail: "Runs the project and who is in it." },
  { id: "member", title: "Member", detail: "Works on its tasks." },
  { id: "viewer", title: "Viewer", detail: "Can look, not change." },
];

/** One line on how open a project is. */
export const accessLine = (access: ProjectAccess | undefined): string =>
  accessChoices.find((choice) => choice.id === (access ?? "open"))?.detail ?? "";

/** Whether the person may put tasks in a project. A project the server did not describe is open to them. */
export const canWorkIn = (project: { you?: { canWork: boolean } }): boolean =>
  project.you?.canWork !== false;

/**
 * Whether the person may change a task, as its project lets them: not when it is in a project they can
 * only look at. A task the app has no project for is theirs, as before.
 */
export function canChangeTask(
  task: { projectId?: string | null },
  projects: { id: string; you?: { canWork: boolean } }[],
): boolean {
  const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
  return !project || canWorkIn(project);
}

/** Whether what was typed is the project's name: the proof that the person means this project. */
export const nameMatches = (typed: string, name: string): boolean =>
  typed.trim().toLowerCase() === name.trim().toLowerCase();

/**
 * Where a deleted project's tasks can go: any other project work may be put in, General first and then
 * by name, narrowed by what was typed.
 */
export function destinations<T extends { id: string; name: string; you?: { canWork: boolean } }>(
  projects: T[],
  deleted: string,
  query = "",
): T[] {
  const wanted = query.trim().toLowerCase();
  return projects
    .filter(
      (project) =>
        project.id !== deleted && canWorkIn(project) && project.name.toLowerCase().includes(wanted),
    )
    .sort(
      (a, b) =>
        Number(b.id === GENERAL_PROJECT_ID) - Number(a.id === GENERAL_PROJECT_ID) ||
        a.name.localeCompare(b.name),
    );
}

/** The letters in a person's mark: the first of their first and last names, or the start of the address. */
export function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  const base = words[0] ?? email.split("@")[0] ?? "";
  return base.slice(0, 2).toUpperCase() || "?";
}

/** Who to draw in a row of marks, and how many more there are. */
export function markRow<T>(people: T[], most = 5): { shown: T[]; more: number } {
  return { shown: people.slice(0, most), more: Math.max(0, people.length - most) };
}

/** How open a project is, in one word. */
export const accessWord = (access: ProjectAccess | undefined): string =>
  accessChoices.find((choice) => choice.id === (access ?? "open"))?.title ?? "";
