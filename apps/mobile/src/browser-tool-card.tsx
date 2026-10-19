import { Check, ChevronRight, Globe2 } from "lucide-react-native";
import { createContext, useContext, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Pressable, Text, View } from "react-native";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src";
import { colors, IconSlot, radius, s, type WebPressState } from "./ui";
import { useWorkspace } from "./workspace";

export const BrowserRunContext = createContext({ running: false, active: false });

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.url(),
});

function resultValue(result: unknown) {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

function siteLabel(url: unknown) {
  if (typeof url !== "string") return "Opening a page";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Opening a page";
  }
}

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { api, workspace, open } = useWorkspace();
  const { running, active } = useContext(BrowserRunContext);
  const working = loading && active;
  const value = resultValue(result);
  const observation = observationSchema.safeParse(value);
  const toolError = z.object({ error: z.string() }).safeParse(value);
  const sessionId = observation.success ? observation.data.sessionId : undefined;
  const current = workspace.browsers.find((browser) => browser.id === sessionId);
  const [browser, setBrowser] = useState<BrowserSession>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    async function connect() {
      setError("");
      try {
        const session = await api.request<BrowserSession>(
          `/api/browsers/${encodeURIComponent(sessionId || "")}`,
        );
        if (active) setBrowser(session);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, sessionId, current?.updatedAt, retry]);

  const visited = observation.success ? observation.data : undefined;
  const failure = toolError.success
    ? toolError.data.error
    : !loading && !visited
      ? "The browser did not return a page. Try your request again."
      : "";
  const status = working
    ? "Reading the page…"
    : loading
      ? "Browsing paused"
      : failure
        ? "Couldn’t read the page"
        : `Read ${siteLabel(visited?.url)}`;
  // Taking control is what the line is for; it is there once the page has been read.
  const canOpen = !loading && !!visited && !!browser && !running;
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: 480, gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={canOpen ? `${status}. Take control of the browser` : status}
        disabled={!canOpen}
        onPress={() => browser && open({ type: "browser", browser })}
        style={({ pressed, hovered }: WebPressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 9,
          paddingHorizontal: 14,
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: pressed || (hovered && canOpen) ? colors.surfaceMuted : colors.surface,
        })}
      >
        <Globe2 size={18} color={colors.primary} />
        <View style={{ flexShrink: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
            {visited?.title || siteLabel(url)}
          </Text>
          <Text style={s.small} numberOfLines={1}>
            {status}
          </Text>
        </View>
        <IconSlot>
          {working ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : canOpen ? (
            <ChevronRight size={16} color={colors.muted} />
          ) : visited ? (
            <Check size={16} color={colors.success} accessibilityLabel="Page read" />
          ) : null}
        </IconSlot>
      </Pressable>
      {!!(failure || error) && (
        <View style={[s.row, { gap: 10, paddingHorizontal: 4 }]}>
          <Text style={[s.small, { color: colors.danger, flexShrink: 1 }]}>{failure || error}</Text>
          {!!error && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reconnect preview"
              onPress={() => setRetry((attempt) => attempt + 1)}
            >
              <Text style={[s.small, { fontWeight: "700", color: colors.primaryText }]}>
                Try again
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
