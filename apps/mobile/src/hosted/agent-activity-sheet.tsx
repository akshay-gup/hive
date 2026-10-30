import { Text } from "react-native";
import { AgentFlags } from "../agent-flags";
import { Sheet, s } from "../ui";
import { useWorkspace } from "../workspace";
import { useHosted } from "./context";

/** The same access-checked activity panel wherever a notification opens it. */
export function AgentActivityPanel() {
  const role = useHosted()?.workspace.role;
  const allowed = role === "owner" || role === "admin";
  return allowed ? (
    <AgentFlags owner={role === "owner"} heading={false} />
  ) : (
    <Text style={s.muted}>Only workspace owners and admins can view agent activity.</Text>
  );
}

/** The existing activity panel opened directly from the bell. */
export function AgentActivitySheet() {
  const hosted = useHosted();
  const { close } = useWorkspace();
  return (
    <Sheet title="Agent security alerts" subtitle={hosted?.workspace.name} onClose={close}>
      <AgentActivityPanel />
    </Sheet>
  );
}
