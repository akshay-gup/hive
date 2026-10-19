import { Bell, FolderOpen, Menu } from "lucide-react-native";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import type { Section } from "../../../packages/domain/src";
import { ORCHESTRATOR_CHANNEL_ID } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { ChannelChatBanner } from "./chat";
import { ComputerEntry } from "./computer";
import { useMuseThread } from "./threads";
import { colors, fontSize, GlassBar, IconButton, layout, Mascot, radius, s } from "./ui";
import { useWorkspace } from "./workspace";

const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "Activity", subtitle: "Plans, progress, decisions and results." },
  ideas: { title: "Ideas", subtitle: "Useful next steps, grounded in your world." },
  goals: {
    title: "Goals",
    subtitle: "Longer-term goals and things to keep an eye on.",
  },
  apps: {
    title: "Apps",
    subtitle: "Connections, capabilities and what the team's agent remembers.",
  },
  connections: { title: "Apps", subtitle: "Connections and capabilities." },
  mail: { title: "Mail", subtitle: "The conversations behind your work." },
  calendar: { title: "Calendar", subtitle: "Time for what matters." },
  browser: { title: "Browser", subtitle: "Your connected browsing sessions." },
  files: { title: "Files", subtitle: "Documents, forms and filled copies." },
};

/**
 * The bar across the top of the main area: what this screen is, what the agent is doing, and the
 * bell. On a narrow screen it also carries the button that opens the sidebar.
 */
export function ShellHeader({ onMenu }: { onMenu: () => void }) {
  const { workspace, section, navigate, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const { selection, enabled: richThreads } = useMuseThread();
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const channelChat = section === "chat" && selection.id.startsWith("channel:");
  const pending =
    (data?.notifications.filter((n) => !n.read).length || 0) +
    workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const activeTask =
    data?.tasks.find(
      (task) =>
        task.status === "waiting_approval" ||
        task.status === "waiting_input" ||
        task.status === "in_review",
    ) || data?.tasks.find((task) => task.status === "running");
  const agentName = data?.identity.name || "Hive";
  const status = activeTask
    ? activeTask.status === "waiting_approval"
      ? `Ready to review · ${activeTask.title}`
      : activeTask.status === "waiting_input"
        ? `Needs your input · ${activeTask.title}`
        : activeTask.status === "in_review"
          ? `Ready for your review · ${activeTask.title}`
          : activeTask.plan.find((step) => step.status === "running")?.title || activeTask.title
    : data?.tasks.some((task) => task.status === "queued")
      ? "Picking up your next task…"
      : "Here when you need me";
  const title = titles[section] || titles.apps;
  return (
    <GlassBar
      kind="bar"
      glass={!desktop}
      style={{
        height: layout.headerHeight,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        ...(desktop
          ? { paddingHorizontal: 20 }
          : {
              paddingHorizontal: 8,
            }),
      }}
    >
      {!desktop && <IconButton icon={Menu} label="Open workspace navigation" onPress={onMenu} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        {channelChat ? (
          <ChannelChatBanner channelId={selection.id.slice("channel:".length)} />
        ) : section === "chat" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${agentName} activity and approvals`}
            onPress={() => navigate("activity")}
            style={[s.row, { gap: 10 }]}
          >
            <Mascot size={32} variant={data?.identity.avatar} />
            <View style={{ flex: 1 }}>
              <Text style={[s.heading, { fontSize: fontSize.heading, lineHeight: 20 }]}>
                {agentName}
              </Text>
              <Text style={s.small} numberOfLines={1}>
                {status}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View>
            <Text style={[s.heading, { fontSize: fontSize.heading, lineHeight: 22 }]}>
              {title?.title}
            </Text>
            <Text style={s.small} numberOfLines={1}>
              {title?.subtitle}
            </Text>
          </View>
        )}
      </View>
      {desktop && section === "chat" && !channelChat && <ComputerEntry />}
      {section === "chat" && !channelChat && !richThreads && (
        <IconButton
          icon={FolderOpen}
          label="Files in this chat"
          onPress={() => open({ type: "channelFiles", channelId: ORCHESTRATOR_CHANNEL_ID })}
        />
      )}
      <View>
        <IconButton
          icon={Bell}
          label={`Notifications, ${pending} unread or pending`}
          onPress={() => open({ type: "notifications" })}
        />
        {pending > 0 && (
          <View
            pointerEvents="none"
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              paddingHorizontal: 4,
              position: "absolute",
              top: 4,
              right: 3,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.primary,
              borderWidth: 2,
              borderColor: colors.canvas,
            }}
          >
            <Text
              style={{
                color: colors.onPrimary,
                fontSize: fontSize.micro,
                lineHeight: 12,
                fontWeight: "700",
              }}
            >
              {pending > 9 ? "9+" : pending}
            </Text>
          </View>
        )}
      </View>
    </GlassBar>
  );
}
