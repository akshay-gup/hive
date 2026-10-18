import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, Field, fontSize, Mascot, pageBee, s } from "../ui";
import type { InvitePreview } from "./control-api";
import { Frame } from "./frame";
import { Notice } from "./notice";

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
  notice,
  onGoogle,
  onEmail,
}: {
  options: SignInOptions;
  /** What the invitation link the person arrived by is for, when they arrived by one. */
  invite?: InvitePreview | null;
  busy: boolean;
  error: string;
  /** Something that has just happened, such as the account being deleted. */
  notice?: string;
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
      {/* The card stays while the sign-in goes through, quiet and out of reach with the spinner over
          it: taking it away would leave a spinner where it was and move everything round it. */}
      <View style={{ width: "100%" }}>
        <View
          style={{ opacity: busy ? 0.4 : 1 }}
          pointerEvents={busy ? "none" : "auto"}
          accessibilityElementsHidden={busy}
          importantForAccessibility={busy ? "no-hide-descendants" : "auto"}
        >
          <Card style={{ width: "100%" }}>
            {!!notice && (
              <View style={{ marginBottom: 12 }}>
                <Notice text={notice} />
              </View>
            )}
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
                  This Hive is in sample mode: any email address signs in, so it is for trying
                  things out.
                </Text>
              </>
            )}
            {!options.google && !options.email && (
              <Text style={s.muted}>Signing in is not set up on this Hive yet.</Text>
            )}
          </Card>
        </View>
        {busy && (
          <View
            pointerEvents="none"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Signing in"
            style={[StyleSheet.absoluteFill, s.centred]}
          >
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
      </View>
    </Frame>
  );
}
