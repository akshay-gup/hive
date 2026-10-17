import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { Button, ErrorNotice, Field, Sheet, s } from "../ui";
import { matchesConfirmation } from "./account-deletion";

/**
 * A question that cannot be taken back. With a `word`, the button stays off until the person has
 * typed it, which is the name of the thing that is about to go, so that it is not pressed by habit.
 * Without one it is a plain confirm, for what can be undone.
 */
export function TypedConfirmSheet({
  title,
  subtitle,
  children,
  word,
  confirmLabel,
  busyText,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  word?: string;
  confirmLabel: string;
  /** Said while it is under way. */
  busyText?: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = word === undefined || matchesConfirmation(typed, word);
  return (
    <Sheet title={title} subtitle={subtitle} onClose={busy ? () => {} : onClose}>
      <View style={{ gap: 16 }}>
        {children}
        {word !== undefined && (
          <Field
            label={`Type ${word} to confirm`}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onSubmitEditing={() => {
              if (ready && !busy) onConfirm();
            }}
          />
        )}
        <ErrorNotice error={error} />
        {busy && !!busyText && <Text style={s.small}>{busyText}</Text>}
        <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
          <Button danger busy={busy} disabled={!ready} onPress={onConfirm}>
            {confirmLabel}
          </Button>
          <Button disabled={busy} onPress={onClose}>
            Cancel
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
