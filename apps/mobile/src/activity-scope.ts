import type { ActionProposal, ActivityEntry } from "../../../packages/domain/src";

/**
 * What the Activity tab shows for a project: the reviews and the timeline of the tasks that are in it.
 * With no project (all the work) it is everything, the workspace's own entries too; in a project, an
 * entry that is not about one of its tasks is not its to show.
 */
export function scopeActivity(
  all: { actions: ActionProposal[]; activity: ActivityEntry[] },
  tasks: { id: string; projectId?: string | null }[],
  projectId: string | null,
): { actions: ActionProposal[]; activity: ActivityEntry[] } {
  if (projectId === null) return all;
  const inProject = new Set(tasks.filter((task) => task.projectId === projectId).map((t) => t.id));
  const actions = all.actions.filter((action) => !!action.taskId && inProject.has(action.taskId));
  const named = new Set(actions.map((action) => action.id));
  return {
    actions,
    activity: all.activity.filter((entry) => !!entry.actionId && named.has(entry.actionId)),
  };
}
