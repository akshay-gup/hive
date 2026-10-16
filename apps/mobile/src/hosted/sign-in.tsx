import { useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { Button, Card, colors, ErrorNotice, Field, fontSize, Mascot, pageBee, s } from "../ui";
import type { InvitePreview } from "./control-api";
import { Frame } from "./frame";

/** The ways this control plane lets a person in. */
export interface SignInOptions {
  google: boolean;
  /** A sample control plane, for a laptop, takes anyone's email address. */
  email: boolean;
}

export function SignInScreen({
  options,
  invite,
  busy,
  error,
  onGoogle,
  onEmail,
}: {
  options: SignInOptions;
  /** What the invitation link the person arrived by is for, when they arrived by one. */
  invite?: InvitePreview | null;
  busy: boolean;
  error: string;
  onGoogle: () => void;
  onEmail: (email: string, name: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  return (
    <Frame>
      <Mascot size={pageBee} />
      <Text
        style={{
          fontSize: fontSize.display,
          color: colors.text,
          letterSpacing: -1,
          fontWeight: "500",
          textAlign: "center",
        }}
      >
        Welcome to Hive.
      </Text>
      <Text style={[s.muted, { textAlign: "center" }]}>
        {invite
          ? `${invite.inviterName} invited you to join ${invite.workspaceName}. Sign in to accept.`
          : "Team chat with an agent in the room."}
      </Text>
      {busy ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <Card style={{ width: "100%" }}>
          <ErrorNotice error={error} />
          {options.google && (
            <Button primary onPress={onGoogle}>
              Continue with Google
            </Button>
          )}
          {options.email && (
            <>
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                onSubmitEditing={() => email.trim() && onEmail(email, name)}
              />
              <Field
                label="Name (optional)"
                value={name}
                onChangeText={setName}
                placeholder="What should people call you?"
                autoComplete="name"
                textContentType="name"
                onSubmitEditing={() => email.trim() && onEmail(email, name)}
              />
              <Button primary disabled={!email.trim()} onPress={() => onEmail(email, name)}>
                Continue
              </Button>
              <Text style={[s.small, { marginTop: 15 }]}>
                This Hive is in sample mode: any email address signs in, so it is for trying things
                out.
              </Text>
            </>
          )}
          {!options.google && !options.email && (
            <Text style={s.muted}>Signing in is not set up on this Hive yet.</Text>
          )}
        </Card>
      )}
    </Frame>
  );
}
