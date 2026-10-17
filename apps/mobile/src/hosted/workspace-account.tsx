import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import { colors, Sheet } from "../ui";
import { useWorkspace } from "../workspace";
import { AccountSheet } from "./account-sheet";
import { useHosted } from "./context";
import type { WorkspaceSummary } from "./control-api";

/**
 * The account sheet as a workspace opens it. The list of workspaces is asked for fresh, since an
 * owner's answer depends on who is in the workspace they own, which may not be this one.
 */
export function WorkspaceAccountSheet() {
  const hosted = useHosted();
  const { close, open } = useWorkspace();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const control = hosted?.control;
  const current = hosted?.workspace;
  useEffect(() => {
    if (!control || !current) return;
    let live = true;
    control
      .me()
      .then((me) => live && setWorkspaces(me.workspaces))
      // Without the list, the one it is open on is the best it knows.
      .catch(() => live && setWorkspaces([current]));
    return () => {
      live = false;
    };
  }, [control, current]);

  if (!hosted) return null;
  if (!workspaces)
    return (
      <Sheet title="Account" subtitle={hosted.account.email} onClose={close}>
        <ActivityIndicator color={colors.primary} />
      </Sheet>
    );
  return (
    <AccountSheet
      control={hosted.control}
      account={hosted.account}
      workspaces={workspaces}
      onClose={close}
      onSignOut={() => {
        close();
        void hosted.signOut();
      }}
      onDeleted={hosted.accountDeleted}
      onOpenWorkspace={() => open({ type: "people" })}
    />
  );
}
