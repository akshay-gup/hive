import LogOut from "lucide-react-native/dist/esm/icons/log-out";
import Plus from "lucide-react-native/dist/esm/icons/plus";
import Trash2 from "lucide-react-native/dist/esm/icons/trash-2";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { WarmBee } from "../animated-bee";
import {
  Button,
  Card,
  CreateTile,
  colors,
  ErrorNotice,
  Field,
  fontSize,
  Mascot,
  pageBee,
  s,
} from "../ui";
import type { ControlAccount, WorkspaceSummary } from "./control-api";
import { Frame } from "./frame";
import { inviteTokenFrom } from "./invite-link";
import { Notice } from "./notice";
import { roleLabel } from "./people-text";

function statusText(workspace: WorkspaceSummary) {
  if (workspace.status === "provisioning") return "Setting up…";
  if (workspace.status === "failed") return "Could not be started";
  return roleLabel[workspace.role];
}

/** The person's workspaces: open one, make one, or join one with a link. */
export function WorkspacesScreen({
  account,
  workspaces,
  error,
  busy,
  onOpen,
  onCreate,
  onRetry,
  onJoin,
  onSignOut,
  onAccount,
  onRemove,
  notice,
  maxWorkspaces,
}: {
  account: ControlAccount;
  workspaces: WorkspaceSummary[];
  /** How many workspaces one person may be in. Without it, no limit is known and none is shown. */
  maxWorkspaces?: number;
  error: string;
  busy: boolean;
  onOpen: (workspace: WorkspaceSummary) => void;
  onCreate: (name: string) => void;
  onRetry: (workspace: WorkspaceSummary) => void;
  onJoin: (inviteToken: string) => void;
  onSignOut: () => void;
  /** Open the account: who they are, signing out, deleting it. */
  onAccount: () => void;
  /** Delete the workspace (an owner) or leave it. It works on one that cannot be opened. */
  onRemove: (workspace: WorkspaceSummary) => void;
  /** Something that has just happened, such as a workspace being deleted. */
  notice?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [nameError, setNameError] = useState("");
  const empty = workspaces.length === 0;
  // Made or joined, a person is in as many as they are allowed: then there is nothing to add.
  const full = maxWorkspaces !== undefined && workspaces.length >= maxWorkspaces;
  const showCreate = !full && (creating || empty);
  const submit = () => {
    // A button that is switched off says nothing, so this one stays on and says what is missing.
    if (!name.trim()) {
      setNameError("Enter a name for your workspace.");
      return;
    }
    setNameError("");
    onCreate(name.trim());
  };
  const join = () => {
    const token = inviteTokenFrom(link);
    if (!token) {
      setLinkError("That does not look like an invitation link.");
      return;
    }
    setLinkError("");
    onJoin(token);
  };
  return (
    <Frame wide>
      {/* The screen after this one has the moving bee, a megabyte or so: fetch it while a name is typed. */}
      {showCreate && <WarmBee loop={1} />}
      <Mascot size={pageBee} />
      <View style={{ alignItems: "center", gap: 6 }}>
        <Text
          style={{
            fontSize: fontSize.display,
            color: colors.text,
            letterSpacing: -1,
            fontWeight: "500",
            textAlign: "center",
          }}
        >
          {empty ? "Make your first workspace" : "Your workspaces"}
        </Text>
        <Text style={[s.muted, { textAlign: "center" }]}>
          {empty
            ? "A workspace is your team's room: its chat, its files and one shared agent."
            : "Pick up where you left off, or start another."}
        </Text>
      </View>
      <Notice text={notice} />
      <ErrorNotice error={error} />
      <View style={{ width: "100%", gap: 12 }}>
        {workspaces.map((workspace) => (
          <Card key={workspace.id} style={{ gap: 10 }}>
            <View style={[s.row, { gap: 12 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.heading} numberOfLines={1}>
                  {workspace.name}
                </Text>
                <Text style={s.small}>{statusText(workspace)}</Text>
              </View>
              {workspace.status === "ready" && (
                <Button primary small onPress={() => onOpen(workspace)}>
                  Open
                </Button>
              )}
              {workspace.status === "provisioning" && <ActivityIndicator color={colors.primary} />}
              {workspace.status === "failed" && workspace.role === "owner" && (
                <Button small onPress={() => onRetry(workspace)}>
                  Try again
                </Button>
              )}
            </View>
            {workspace.status === "failed" && (
              <ErrorNotice error={workspace.error ?? "We could not start this workspace."} />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${workspace.role === "owner" ? "Delete" : "Leave"} workspace ${workspace.name}`}
              hitSlop={8}
              onPress={() => onRemove(workspace)}
              style={[s.row, { gap: 6, alignSelf: "flex-start", paddingVertical: 4 }]}
            >
              {workspace.role === "owner" ? (
                <Trash2 size={14} color={colors.danger} />
              ) : (
                <LogOut size={14} color={colors.danger} />
              )}
              <Text style={[s.small, { color: colors.danger }]}>
                {workspace.role === "owner" ? "Delete workspace" : "Leave workspace"}
              </Text>
            </Pressable>
          </Card>
        ))}
        {showCreate ? (
          <Card style={{ gap: 4 }}>
            <Field
              label="Workspace name"
              value={name}
              onChangeText={(value) => {
                setName(value);
                if (value.trim()) setNameError("");
              }}
              placeholder="Acme"
              maxLength={60}
              autoFocus={!empty}
              onSubmitEditing={submit}
            />
            <ErrorNotice error={nameError} />
            <View style={[s.row, { gap: 10 }]}>
              <Button primary busy={busy} onPress={submit}>
                Create workspace
              </Button>
              {!empty && (
                <Button disabled={busy} onPress={() => setCreating(false)}>
                  Cancel
                </Button>
              )}
            </View>
          </Card>
        ) : full ? (
          <Text style={[s.small, { textAlign: "center" }]}>
            {maxWorkspaces === 1
              ? "You can be in one workspace. Leave or delete yours to make or join another."
              : `You can be in up to ${maxWorkspaces} workspaces.`}
          </Text>
        ) : (
          <CreateTile icon={Plus} label="Create a workspace" onPress={() => setCreating(true)} />
        )}
      </View>
      {full ? null : joining ? (
        <Card style={{ width: "100%", gap: 4 }}>
          <Field
            label="Invitation link"
            value={link}
            onChangeText={setLink}
            placeholder="Paste the link you were sent"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={join}
          />
          <ErrorNotice error={linkError} />
          <View style={[s.row, { gap: 10 }]}>
            <Button primary onPress={join}>
              Join
            </Button>
            <Button onPress={() => setJoining(false)}>Cancel</Button>
          </View>
        </Card>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Join a workspace with an invitation link"
          onPress={() => setJoining(true)}
        >
          <Text style={[s.small, { color: colors.primaryText }]}>Have an invitation link?</Text>
        </Pressable>
      )}
      <View style={{ alignItems: "center", gap: 4 }}>
        <Text style={s.small}>Signed in as {account.email}</Text>
        <View style={[s.row, { gap: 18 }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Account" onPress={onAccount}>
            <Text style={[s.small, { color: colors.primaryText }]}>Account</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={onSignOut}>
            <Text style={[s.small, { color: colors.primaryText }]}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    </Frame>
  );
}
