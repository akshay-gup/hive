import { Plus } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
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
import type { ControlAccount, Role, WorkspaceSummary } from "./control-api";
import { Frame } from "./frame";
import { inviteTokenFrom } from "./invite-link";

const roleLabel: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

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
}: {
  account: ControlAccount;
  workspaces: WorkspaceSummary[];
  error: string;
  busy: boolean;
  onOpen: (workspace: WorkspaceSummary) => void;
  onCreate: (name: string) => void;
  onRetry: (workspace: WorkspaceSummary) => void;
  onJoin: (inviteToken: string) => void;
  onSignOut: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const empty = workspaces.length === 0;
  const showCreate = creating || empty;
  const submit = () => {
    if (name.trim()) onCreate(name.trim());
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
          </Card>
        ))}
        {showCreate ? (
          <Card style={{ gap: 4 }}>
            <Field
              label="Workspace name"
              value={name}
              onChangeText={setName}
              placeholder="Acme"
              maxLength={60}
              autoFocus={!empty}
              onSubmitEditing={submit}
            />
            <View style={[s.row, { gap: 10 }]}>
              <Button primary busy={busy} disabled={!name.trim()} onPress={submit}>
                Create workspace
              </Button>
              {!empty && (
                <Button disabled={busy} onPress={() => setCreating(false)}>
                  Cancel
                </Button>
              )}
            </View>
          </Card>
        ) : (
          <CreateTile icon={Plus} label="Create a workspace" onPress={() => setCreating(true)} />
        )}
      </View>
      {joining ? (
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
            <Button primary disabled={!link.trim()} onPress={join}>
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
        <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={onSignOut}>
          <Text style={[s.small, { color: colors.primaryText }]}>Sign out</Text>
        </Pressable>
      </View>
    </Frame>
  );
}
