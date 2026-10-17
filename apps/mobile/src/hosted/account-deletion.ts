import type { WorkspaceSummary } from "./control-api";

/**
 * What deleting an account has to do, given where the person stands. A workspace needs its owner,
 * so an owner takes the workspace with them when they are the only one in it, and otherwise has to
 * delete it first, which is the one thing that would take it from everyone else.
 */
export type DeletionPlan =
  /** In no workspace, or only as an admin or member: they are taken out of it, and the account goes. */
  | { kind: "plain" }
  /** Owns one, and has not yet found out who else is in it. */
  | { kind: "checking"; workspace: WorkspaceSummary }
  /** Owns one that no one else is in: it goes first, then the account. */
  | { kind: "owner-alone"; workspace: WorkspaceSummary }
  /** Owns one with other people in it: it is theirs to delete, or not, before the account. */
  | { kind: "owner-with-others"; workspace: WorkspaceSummary; others: number };

/** `people` is how many are in the workspace they own, themselves included, once that is known. */
export function planAccountDeletion(
  workspaces: WorkspaceSummary[],
  people: number | undefined,
): DeletionPlan {
  const workspace = workspaces.find((candidate) => candidate.role === "owner");
  if (!workspace) return { kind: "plain" };
  if (people === undefined) return { kind: "checking", workspace };
  return people <= 1
    ? { kind: "owner-alone", workspace }
    : { kind: "owner-with-others", workspace, others: people - 1 };
}

/** What a person types to show they mean it: their email, or the name of the workspace that goes with it. */
export function confirmationWord(plan: DeletionPlan, email: string): string | null {
  if (plan.kind === "plain") return email;
  if (plan.kind === "owner-alone") return plan.workspace.name;
  return null;
}

/** Typed by hand, so case and stray spaces do not count against them. */
export function matchesConfirmation(typed: string, word: string): boolean {
  return typed.trim().toLowerCase() === word.trim().toLowerCase() && word.trim() !== "";
}
