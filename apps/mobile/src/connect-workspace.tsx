import { useState } from "react";
import { Text } from "react-native";
import { probeWorkspace } from "./api";
import { Button, Card, ErrorNotice, Field, s } from "./ui";
import { normalizeWorkspaceUrl, workspaceLabel } from "./workspace-url";

/** Asks which workspace to open, and only goes on once something answers there as a Hive workspace. */
export function ConnectWorkspace({
  initial,
  onConnect,
}: {
  initial: string;
  onConnect: (url: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const submit = async () => {
    if (checking) return;
    const address = normalizeWorkspaceUrl(text);
    if ("error" in address) {
      setError(address.error);
      return;
    }
    setChecking(true);
    setError("");
    const found = await probeWorkspace(address.url);
    if (!found.ok) {
      setChecking(false);
      setError(
        `Could not reach a Hive workspace at ${workspaceLabel(address.url)}. Check the address, that it is running, and that it allows this app.`,
      );
      return;
    }
    await onConnect(address.url);
    setChecking(false);
  };
  return (
    <Card style={{ width: "100%" }}>
      <Text style={[s.title, { marginBottom: 6 }]}>Open your workspace</Text>
      <Text style={[s.small, { marginBottom: 14 }]}>
        Enter the address your team's Hive runs at. Whoever set it up can tell you.
      </Text>
      <ErrorNotice error={error} />
      <Field
        label="Workspace address"
        placeholder="team.example.com"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setError("");
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Button primary busy={checking} disabled={!text.trim()} onPress={() => void submit()}>
        Continue
      </Button>
    </Card>
  );
}
