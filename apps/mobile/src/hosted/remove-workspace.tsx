import { useState } from "react";
import { Text } from "react-native";
import { s } from "../ui";
import type { ControlApi, WorkspaceSummary } from "./control-api";
import { TypedConfirmSheet } from "./typed-confirm";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Take a workspace away from the person who is asking: an owner deletes it for everyone, which
 * they confirm by typing its name; anyone else leaves it, which they can be invited back from.
 * `onDone` is told what to say about it.
 */
export function RemoveWorkspaceSheet({
  workspace,
  control,
  accountId,
  onClose,
  onDone,
}: {
  workspace: WorkspaceSummary;
  control: ControlApi;
  accountId: string;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const owner = workspace.role === "owner";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      if (owner) await control.deleteWorkspace(workspace.id);
      else await control.removeMember(workspace.id, accountId);
      onDone(owner ? `${workspace.name} was deleted.` : `You left ${workspace.name}.`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return owner ? (
    <TypedConfirmSheet
      title={`Delete ${workspace.name}?`}
      word={workspace.name}
      confirmLabel="Delete workspace"
      busyText="Deleting the workspace and shutting its server down. This can take up to a minute."
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Text style={s.muted}>
        This deletes {workspace.name}'s chat, files and agent for everyone in it, and shuts its
        server down. It cannot be undone.
      </Text>
    </TypedConfirmSheet>
  ) : (
    <TypedConfirmSheet
      title={`Leave ${workspace.name}?`}
      confirmLabel="Leave workspace"
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Text style={s.muted}>
        You will lose access to its chat and files. Someone there can invite you back.
      </Text>
    </TypedConfirmSheet>
  );
}
