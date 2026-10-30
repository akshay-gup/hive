import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Platform, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  ApiError,
  apiUrl,
  configuredWorkspaceUrl,
  createSession,
  exchangeLoginCode,
  googleLoginUrl,
  MuseApi,
  probeWorkspace,
  sameOriginWorkspaceUrl,
  savedSession,
  savedWorkspaceUrl,
  saveSession,
  saveWorkspaceUrl,
  setApiUrl,
} from "./src/api";
import { ConnectWorkspace } from "./src/connect-workspace";
import { CONTROL_URL } from "./src/hosted/config";
import { HostedApp } from "./src/hosted/HostedApp";
import { beginSignIn, cancelSignIn, takeSignInAttempt } from "./src/sign-in-attempt";
import { Backdrop, Button, Card, colors, ErrorNotice, fontSize, haze, Mascot, s } from "./src/ui";
import { WorkspaceApp } from "./src/workspace-app";
import { workspaceLabel } from "./src/workspace-url";

/** Which workspace to open: the one chosen before, else what this build points at, else the page's own server. */
async function findWorkspace(): Promise<string | undefined> {
  const saved = await savedWorkspaceUrl();
  if (saved) return saved;
  const configured = configuredWorkspaceUrl();
  if (configured) return configured;
  const origin = sameOriginWorkspaceUrl();
  if (origin && (await probeWorkspace(origin)).ok) return origin;
  return undefined;
}

function SelfHostedApp() {
  // undefined while looking; null when the person has to say which workspace.
  const [workspace, setWorkspace] = useState<string | null>();
  const [token, setToken] = useState("");
  const api = useMemo(
    () => (token && workspace ? new MuseApi(token, workspace) : null),
    [token, workspace],
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const openWorkspace = useCallback(async (url: string) => {
    await cancelSignIn();
    setApiUrl(url);
    await saveWorkspaceUrl(url);
    setToken("");
    setError("");
    setBusy(true);
    setWorkspace(url);
  }, []);
  const askForWorkspace = useCallback(() => {
    void cancelSignIn();
    setToken("");
    setError("");
    setBusy(false);
    setWorkspace(null);
  }, []);
  const connect = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await savedSession();
      if (saved) {
        try {
          await new MuseApi(saved, apiUrl()).request("/api/auth/session");
          setToken(saved);
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 401) throw e;
          await saveSession("");
        }
      }
      const session = await createSession();
      await saveSession(session.token);
      setToken(session.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const finishGoogleSignIn = useCallback(async (code: string) => {
    setBusy(true);
    setError("");
    try {
      // Only a code this app asked for, with the proof it kept, can be spent.
      const attempt = await takeSignInAttempt();
      if (!attempt) throw new Error("That sign-in is no longer valid. Start it again.");
      setApiUrl(attempt.workspace);
      setWorkspace(attempt.workspace);
      const session = await exchangeLoginCode(code, attempt.proof);
      await saveSession(session.token);
      setToken(session.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const logout = useCallback(async () => {
    try {
      await api?.request("/api/auth/logout", {});
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
    }
    await saveSession("");
    setToken("");
    setError("");
    setBusy(false);
  }, [api]);
  const signInWithGoogle = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const onWeb = Platform.OS === "web" && typeof window !== "undefined";
      const { challenge } = await beginSignIn();
      const { url } = await googleLoginUrl({
        origin: onWeb ? window.location.origin : undefined,
        challenge,
      });
      if (onWeb) {
        const popup = window.open(url, "hive-google-signin", "width=520,height=640");
        if (!popup) throw new Error("Allow popups to sign in with Google.");
        const timer = setInterval(() => {
          if (popup.closed) {
            clearInterval(timer);
            setBusy(false);
          }
        }, 500);
      } else {
        await Linking.openURL(url);
        setBusy(false);
      }
    } catch (e) {
      void cancelSignIn();
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    let current = true;
    void findWorkspace().then((found) => {
      if (!current) return;
      if (found) {
        setApiUrl(found);
        setWorkspace(found);
      } else {
        setBusy(false);
        setWorkspace(null);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (workspace) void connect();
  }, [workspace, connect]);
  // Web: the sign-in popup posts back { hiveAuthCode } (see server callback page).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !workspace) return;
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(apiUrl()).origin;
    } catch {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const code = (event.data as { hiveAuthCode?: unknown } | null)?.hiveAuthCode;
      if (typeof code === "string" && code) void finishGoogleSignIn(code);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [workspace, finishGoogleSignIn]);
  // Native: the server redirects to hive://auth?code=... after sign-in.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const handle = (url: string | null) => {
      if (!url) return;
      const match = url.match(/^hive:\/\/auth\?code=([^&]+)/);
      if (match?.[1]) void finishGoogleSignIn(decodeURIComponent(match[1]));
    };
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    return () => sub.remove();
  }, [finishGoogleSignIn]);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {api ? (
        <WorkspaceApp api={api} identity={token} logout={logout} />
      ) : (
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: haze.base,
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
        >
          <Backdrop />
          <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
            <Mascot size={72} />
            <Text
              style={{
                fontSize: fontSize.display,
                color: colors.text,
                letterSpacing: -1,
                fontWeight: "500",
              }}
            >
              Welcome to Hive.
            </Text>
            <Text style={[s.muted, { textAlign: "center" }]}>A little room for your day.</Text>
            {workspace === null ? (
              <ConnectWorkspace initial="" onConnect={openWorkspace} />
            ) : busy || !workspace ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Card style={{ width: "100%" }}>
                <ErrorNotice error={error} />
                <Button primary onPress={() => void signInWithGoogle()}>
                  Sign in with Google
                </Button>
                <Text style={[s.small, { marginTop: 15, marginBottom: 10, textAlign: "center" }]}>
                  Workspace: {workspaceLabel(workspace)}
                </Text>
                <Button small onPress={askForWorkspace}>
                  Use a different workspace
                </Button>
              </Card>
            )}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}

/**
 * A build with a control plane (EXPO_PUBLIC_CONTROL_URL) is the hosted app, where people sign in
 * once and have workspaces; any other opens one workspace server directly.
 */
export default function App() {
  return CONTROL_URL ? <HostedApp controlUrl={CONTROL_URL} /> : <SelfHostedApp />;
}
