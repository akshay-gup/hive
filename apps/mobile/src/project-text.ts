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
    detail: "Workspace members can view the project and edit its tasks.",
  },
  {
    id: "limited",
    title: "Limited",
    detail: "Workspace members can view it. Project admins and members can edit tasks.",
  },
  {
    id: "private",
    title: "Private",
    detail: "Only people added to the project can view it and its tasks.",
  },
];

export const roleChoices: { id: ProjectRole; title: string; detail: string }[] = [
  { id: "admin", title: "Admin", detail: "Manages tasks, settings and people." },
  { id: "member", title: "Member", detail: "Creates and edits tasks." },
  { id: "viewer", title: "Viewer", detail: "Views tasks without editing them." },
];

export const projectAccessNote =
  "Workspace owners and admins can view and manage every project, including private ones. Guests need to be added to each project.";

export const projectRoleNote =
  "Open access lets workspace members edit tasks even with the Viewer role. Guests follow their project role.";

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
