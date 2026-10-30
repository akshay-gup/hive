import Upload from "lucide-react-native/dist/esm/icons/upload";
import { createContext, useContext, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { AgentCard } from "./chat-agent-extra";
import { fileSize } from "./file-format";
import { type PickedFile, pickFiles } from "./file-upload";
import { JevToolCard } from "./jev-tool-card";
import { parseUploadRequest } from "./tool-results";
import { Button, Card, Chip, colors, ErrorNotice, IconSlot, s } from "./ui";

/** What the cards an agent leaves in a conversation can do there. */
export interface ChannelCardActions {
  /** Send the files as the person's next message, which is how the agent is given them. */
  sendFiles: (files: PickedFile[]) => Promise<void>;
  /** The person has written since this agent message, so what it asked has been answered. */
  answered: (messageId: string) => boolean;
  /** The agent is still replying. */
  busy: boolean;
}

export const ChannelCardsContext = createContext<ChannelCardActions | null>(null);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An agent's request for files, in the conversation: what it needs, and a button to send them. */
function UploadAsk({ prompt, accept, multiple, messageId }: UploadAskProps) {
  const actions = useContext(ChannelCardsContext);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  if (!actions) return null;
  const answered = actions.answered(messageId);

  async function choose() {
    setError("");
    try {
      const chosen = await pickFiles({ accept, multiple });
      if (!chosen.length) return;
      setPicked(multiple ? chosen : chosen.slice(0, 1));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function send() {
    if (!actions || sending || !picked.length) return;
    setSending(true);
    setError("");
    try {
      await actions.sendFiles(picked);
      setPicked([]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card style={{ padding: 16, gap: 14, maxWidth: 460, width: "100%" }}>
      <View style={[s.row, { gap: 12, alignItems: "flex-start" }]}>
        <View style={s.iconBox}>
          <Upload size={19} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={s.label}>Files needed</Text>
          <Text style={s.text}>{prompt}</Text>
        </View>
      </View>
      {!!accept?.length && (
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          {accept.map((type) => (
            <Chip key={type}>{type.toUpperCase()}</Chip>
          ))}
        </View>
      )}
      {picked.map((file) => (
        <View key={`${file.name}-${file.size ?? 0}`} style={[s.row, { gap: 10 }]}>
          <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
            {file.name}
          </Text>
          {file.size !== undefined && <Text style={s.small}>{fileSize(file.size)}</Text>}
        </View>
      ))}
      <ErrorNotice error={error} />
      {answered && !picked.length ? (
        <Text style={s.small}>You have replied since.</Text>
      ) : (
        <View style={{ gap: 6 }}>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              primary={!picked.length}
              icon={Upload}
              disabled={sending || actions.busy}
              onPress={() => void choose()}
              accessibilityLabel="Choose files for the agent"
            >
              {picked.length ? "Choose again" : multiple ? "Choose files" : "Choose a file"}
            </Button>
            {!!picked.length && (
              <Button small primary busy={sending} onPress={() => void send()}>
                {picked.length === 1 ? "Send file" : `Send ${picked.length} files`}
              </Button>
            )}
          </View>
          {actions.busy && !picked.length && (
            <Text style={s.small}>You can send files once the agent has finished replying.</Text>
          )}
        </View>
      )}
    </Card>
  );
}

interface UploadAskProps {
  prompt: string;
  accept?: string[];
  multiple: boolean;
  messageId: string;
}

/** The card for one `request_upload` call: being made, asked, or not asked and why. */
function UploadCard({ card, messageId }: { card: AgentCard; messageId: string }) {
  const parsed = parseUploadRequest(card.result);
  if (parsed && "channelId" in parsed)
    return (
      <UploadAsk
        prompt={parsed.prompt}
        accept={parsed.accept}
        multiple={parsed.multiple}
        messageId={messageId}
      />
    );
  return (
    <Card style={{ padding: 14, maxWidth: 460, width: "100%" }}>
      {parsed ? (
        <>
          <Text style={[s.text, { fontWeight: "600" }]}>Could not ask for files</Text>
          <ErrorNotice error={parsed.error} />
        </>
      ) : (
        <View style={[s.row, { gap: 10 }]}>
          <IconSlot>
            {card.loading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Upload size={16} color={colors.muted} />
            )}
          </IconSlot>
          <Text style={s.muted}>
            {card.loading ? "Asking for files…" : "The request could not be shown."}
          </Text>
        </View>
      )}
    </Card>
  );
}

/** The choices and requests for files an agent left in its reply. */
export function ChannelCards({ cards, messageId }: { cards: AgentCard[]; messageId: string }) {
  if (!useContext(ChannelCardsContext)) return null;
  return (
    <>
      {cards.map((card) =>
        card.name === "present_choices" ? (
          <JevToolCard key={card.id} result={card.result} loading={card.loading} />
        ) : (
          <UploadCard key={card.id} card={card} messageId={messageId} />
        ),
      )}
    </>
  );
}
