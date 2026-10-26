import type { ProjectAccess, ProjectRole } from "../../../packages/domain/src/agent";

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
