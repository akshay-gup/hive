import { Text, View } from "react-native";
import { Button, Card, ErrorNotice, Mascot, s } from "../ui";
import type { InvitePreview } from "./control-api";
import { Frame } from "./frame";

/** An invitation, and the one thing to do about it: join. */
export function JoinScreen({
  preview,
  error,
  busy,
  onJoin,
  onCancel,
}: {
  /** Null when the link is not one that can be used any more. */
  preview: InvitePreview | null;
  error: string;
  busy: boolean;
  onJoin: () => void;
  onCancel: () => void;
}) {
  return (
    <Frame>
      <Mascot size={80} />
      <Card style={{ width: "100%", gap: 14 }}>
        {preview ? (
          <>
            <Text style={s.title}>Join {preview.workspaceName}</Text>
            <Text style={s.muted}>
              {preview.inviterName} invited you
              {preview.role === "admin" ? " as an admin" : ""}. Everyone in the workspace shares its
              chat, files and agent.
            </Text>
            <ErrorNotice error={error} />
            <View style={{ gap: 10 }}>
              <Button primary busy={busy} onPress={onJoin}>
                Join workspace
              </Button>
              <Button disabled={busy} onPress={onCancel}>
                Not now
              </Button>
            </View>
          </>
        ) : (
          <>
            <Text style={s.title}>This invitation is not valid</Text>
            <Text style={s.muted}>
              It may have expired, been used up, or been withdrawn. Ask the person who invited you
              for a new link.
            </Text>
            <ErrorNotice error={error} />
            <Button primary onPress={onCancel}>
              Continue
            </Button>
          </>
        )}
      </Card>
    </Frame>
  );
}
