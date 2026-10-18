import { LogOut, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, SectionHeading, Sheet, s } from "../ui";
import { confirmationWord, planAccountDeletion } from "./account-deletion";
import type { ControlAccount, ControlApi, WorkspaceSummary } from "./control-api";
import { TypedConfirmSheet } from "./typed-confirm";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The person's account, which is not any one workspace's: who they are, signing out, and deleting
 * the account. It needs nothing from inside a workspace, so the list of workspaces and the
 * workspace both open it. Deleting takes the person out of every workspace they are in; an owner
 * who is alone in theirs takes it with them, and one with company is sent to delete it first.
 */
export function AccountSheet({
  control,
  account,
  workspaces,
  onClose,
  onSignOut,
  onDeleted,
  onOpenWorkspace,
}: {
  control: ControlApi;
  account: ControlAccount;
  /** Null until the list has come, so the sheet is open at once and fills in. */
  workspaces: WorkspaceSummary[] | null;
  onClose: () => void;
  onSignOut: () => void;
  /** The account is gone. */
  onDeleted: () => void;
  /** Where an owner with company goes to delete their workspace. */
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
}) {
  const owned = workspaces?.find((workspace) => workspace.role === "owner");
  const [people, setPeople] = useState<number | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownedId = owned?.id;
  useEffect(() => {
    if (!ownedId) return;
    let live = true;
    control
      .members(ownedId)
      .then((members) => live && setPeople(members.length))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [control, ownedId]);

  const plan = planAccountDeletion(workspaces, people);
  const word = confirmationWord(plan, account.email);

  async function deleteIt() {
    setBusy(true);
    setError("");
    try {
      if (plan.kind === "owner-alone") await control.deleteWorkspace(plan.workspace.id);
      await control.deleteAccount();
      onDeleted();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  if (confirming && word !== null)
    return (
      <TypedConfirmSheet
        title={
          plan.kind === "owner-alone"
            ? `Delete ${plan.workspace.name} and your account?`
            : "Delete your account?"
        }
        word={word}
        confirmLabel={
          plan.kind === "owner-alone" ? "Delete workspace and account" : "Delete my account"
        }
        busyText={
          plan.kind === "owner-alone"
            ? "Deleting the workspace first, then your account. This can take up to a minute."
            : "Deleting your account…"
        }
        busy={busy}
        error={error}
        onConfirm={() => void deleteIt()}
        onClose={() => {
          setConfirming(false);
          setError("");
        }}
      >
        <Text style={s.muted}>
          {plan.kind === "owner-alone"
            ? `This deletes ${plan.workspace.name}, with its chat, files and agent, and shuts its server down. Then it deletes your account and signs you out on every device. It cannot be undone.`
            : "This deletes your account and signs you out on every device. You leave any workspace you are in, and your past messages stay there for the team. It cannot be undone."}
        </Text>
      </TypedConfirmSheet>
    );

  return (
    <Sheet title="Account" subtitle={account.email} onClose={onClose}>
      <ErrorNotice error={error} />
      <Card style={{ gap: 4 }}>
        <Text style={s.heading}>{account.name}</Text>
        <Text style={s.muted}>{account.email}</Text>
      </Card>
      <View style={[s.row, { marginTop: 12 }]}>
        <Button icon={LogOut} onPress={onSignOut}>
          Sign out
        </Button>
      </View>

      <View style={{ marginTop: 28, gap: 12 }}>
        <SectionHeading title="Delete account" />
        {plan.kind === "owner-with-others" ? (
          <>
            <Text style={s.muted}>
              You own {plan.workspace.name}, which has {plan.others}{" "}
              {plan.others === 1 ? "other person" : "other people"} in it. Delete the workspace
              first, which removes it for everyone, and then delete your account.
            </Text>
            <View style={s.row}>
              <Button onPress={() => onOpenWorkspace(plan.workspace)}>
                Go to {plan.workspace.name}
              </Button>
            </View>
          </>
        ) : (
          <>
            {/* Three lines of room, since the words are not known until the workspaces are, and the
                button below should be where it will stay. */}
            <View style={{ minHeight: 3 * 21 }}>
              <Text style={s.muted}>
                {plan.kind === "owner-alone"
                  ? `You own ${plan.workspace.name} and are the only one in it, so deleting your account deletes it too: its chat, files and agent.`
                  : plan.kind === "loading"
                    ? "Checking your workspaces…"
                    : plan.kind === "checking"
                      ? "Checking who is in your workspace…"
                      : "Deletes your account and signs you out everywhere. You leave any workspace you are in. It cannot be undone."}
              </Text>
            </View>
            <View style={[s.row, { gap: 10 }]}>
              <Button
                danger
                icon={Trash2}
                disabled={plan.kind === "checking" || plan.kind === "loading"}
                onPress={() => setConfirming(true)}
              >
                Delete account…
              </Button>
              {(plan.kind === "checking" || plan.kind === "loading") && !error && (
                <ActivityIndicator color={colors.primary} />
              )}
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}
