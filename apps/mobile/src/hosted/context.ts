import { createContext, useContext } from "react";
import type { ControlAccount, ControlApi, WorkspaceSummary } from "./control-api";
import type { WorkspaceUser } from "./open-workspace";

/** What the hosted app lets a workspace's screens do beyond the workspace: who is in it, and the way out. */
export interface HostedContextValue {
  control: ControlApi;
  workspace: WorkspaceSummary;
  account: ControlAccount;
  /** The person as this workspace knows them, with their role in it. */
  user: WorkspaceUser;
  /** Back to the list of workspaces, with a line to say about what brought them there, if any. */
  switchWorkspace: (notice?: string) => void;
  signOut: () => Promise<void>;
  /** The account has been deleted: forget the session and show the sign-in screen. */
  accountDeleted: () => void;
}

export const HostedContext = createContext<HostedContextValue | null>(null);

/** The hosted app's controls, or null in a workspace that is opened directly. */
export function useHosted() {
  return useContext(HostedContext);
}
