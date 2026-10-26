import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { storage } from "../storage";
import { Button } from "../ui";
import { AccountSheet } from "./account-sheet";
import {
  type ControlAccount,
  ControlApi,
  type InvitePreview,
  isControlError,
  type WorkspaceSummary,
} from "./control-api";
import { HostedWorkspace } from "./HostedWorkspace";
import { inviteTokenFrom, inviteTokenFromPath } from "./invite-link";
import { JoinScreen } from "./join";
import { MakingScreen } from "./making";
import { type OpenedWorkspace, openWorkspace, WorkspaceUnavailable } from "./open-workspace";
import { ProgressScreen } from "./progress";
import { RemoveWorkspaceSheet } from "./remove-workspace";
import { type SignInOptions, SignInScreen } from "./sign-in";
import { WorkspacesScreen } from "./workspaces";

type Phase =
  | { name: "boot" }
  | { name: "offline"; error: string }
  | { name: "signed-out" }
  | { name: "home" }
  /** A workspace that is being set up, and that is opened when it is ready. */
  | { name: "making"; workspace: WorkspaceSummary }
  | { name: "opening"; workspace: WorkspaceSummary; step: "waking" | "signing-in" }
  | { name: "stuck"; workspace: WorkspaceSummary; error: string; reason: string }
  | { name: "join" }
  | { name: "workspace"; opened: OpenedWorkspace };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const onWeb = Platform.OS === "web" && typeof window !== "undefined";

/**
 * The Hive app as a product: sign in once, see your workspaces, make one or join one with a link,
 * and be taken into it. Inside a workspace it is the same app a self-hosted workspace shows.
 */
export function HostedApp({ controlUrl }: { controlUrl: string }) {
  const control = useMemo(() => new ControlApi(controlUrl), [controlUrl]);
  const host = useMemo(() => new URL(controlUrl).host, [controlUrl]);
  const sessionKey = `hive.control.session.${host}`;
  const lastKey = `hive.control.last.${host}`;

  const [phase, setPhase] = useState<Phase>({ name: "boot" });
  const [account, setAccount] = useState<ControlAccount | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [maxWorkspaces, setMaxWorkspaces] = useState<number | undefined>();
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootCount, setBootCount] = useState(0);
  // One line about what has just happened (a workspace deleted, the account gone), and the sheet
  // open over the list of workspaces, if one is.
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<
    { name: "account" } | { name: "remove"; workspace: WorkspaceSummary } | null
  >(null);
  // The invitation the person arrived by, kept through signing in, and what it is for.
  const [invite, setInvite] = useState<string | null>(() =>
    onWeb ? inviteTokenFromPath(window.location.pathname) : null,
  );
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const inviteRef = useRef(invite);
  inviteRef.current = invite;

  const clearInvite = useCallback(() => {
    setInvite(null);
    setPreview(undefined);
    if (onWeb && inviteTokenFromPath(window.location.pathname))
      window.history.replaceState(null, "", "/");
  }, []);

  const showSignedOut = useCallback(() => {
    void storage.remove(sessionKey);
    setAccount(null);
    setWorkspaces([]);
    setPhase({ name: "signed-out" });
  }, [sessionKey]);
  useEffect(() => {
    control.onSignedOut = showSignedOut;
    return () => {
      control.onSignedOut = undefined;
    };
  }, [control, showSignedOut]);

  const loadMe = useCallback(async () => {
    const me = await control.me();
    setAccount(me.account);
    setWorkspaces(me.workspaces);
    setMaxWorkspaces(me.maxWorkspaces);
    return me;
  }, [control]);

  const goHome = useCallback(async () => {
    setError("");
    try {
      await loadMe();
      setPhase({ name: "home" });
    } catch (e) {
      if (!isControlError(e) || e.status !== 401) setPhase({ name: "offline", error: message(e) });
    }
  }, [loadMe]);

  const open = useCallback(
    async (workspace: WorkspaceSummary) => {
      setError("");
      setNotice("");
      setPhase({ name: "opening", workspace, step: "waking" });
      try {
        const opened = await openWorkspace(control, workspace.id, {
          onStep: (step) =>
            setPhase((now) =>
              now.name === "opening" && now.workspace.id === workspace.id ? { ...now, step } : now,
            ),
        });
        await storage.set(lastKey, workspace.id);
        setPhase({ name: "workspace", opened });
      } catch (e) {
        if (isControlError(e) && e.status === 401) return; // signed out: the sign-in screen is up
        if (e instanceof WorkspaceUnavailable && e.reason === "not-ready")
          setPhase({ name: "making", workspace });
        else
          setPhase({
            name: "stuck",
            workspace,
            error: message(e),
            reason: e instanceof WorkspaceUnavailable ? e.reason : "other",
          });
      }
    },
    [control, lastKey],
  );

  /** Signed in, with the session set on `control`: remember it and find where the person goes. */
  const enter = useCallback(async () => {
    setNotice("");
    const me = await loadMe();
    await storage.set(sessionKey, control.token);
    if (inviteRef.current) {
      setPhase({ name: "join" });
      return;
    }
    const last = await storage.get(lastKey);
    const ready = me.workspaces.filter((workspace) => workspace.status === "ready");
    const target =
      ready.find((workspace) => workspace.id === last) ??
      (me.workspaces.length === 1 ? ready[0] : undefined);
    if (target) await open(target);
    else setPhase({ name: "home" });
  }, [control, loadMe, lastKey, open, sessionKey]);

  // Starting up: which ways in there are, and whether the session this device kept still works.
  // Only a restart by the person (bootCount) starts this over.
  useEffect(() => {
    let current = true;
    (async () => {
      setPhase({ name: "boot" });
      try {
        const health = await control.health();
        if (!current) return;
        setOptions({ google: health.google, email: health.mode === "sample" });
        const saved = await storage.get(sessionKey);
        if (saved) {
          control.token = saved;
          try {
            await enter();
            return;
          } catch (e) {
            if (!isControlError(e) || e.status !== 401) throw e;
            control.token = "";
            await storage.remove(sessionKey);
          }
        }
        if (current) setPhase({ name: "signed-out" });
      } catch (e) {
        if (current) setPhase({ name: "offline", error: message(e) });
      }
    })();
    return () => {
      current = false;
    };
  }, [bootCount]);

  // What an invitation is for, which anyone holding the link can be told before they sign in.
  useEffect(() => {
    if (!invite) return;
    let current = true;
    control
      .previewInvite(invite)
      .then((found) => current && setPreview(found))
      .catch(() => current && setPreview(null));
    return () => {
      current = false;
    };
  }, [control, invite]);

  // A workspace that is being made is opened when it is ready.
  const makingId = phase.name === "making" ? phase.workspace.id : null;
  const making = phase.name === "making" ? phase.workspace : null;
  const [makingStep, setMakingStep] = useState<string | undefined>();
  useEffect(() => {
    if (!makingId || !making) return;
    const stop = new AbortController();
    setMakingStep(undefined);
    control
      .untilSettled(makingId, {
        signal: stop.signal,
        onUpdate: (workspace) => {
          if (!stop.signal.aborted) setMakingStep(workspace.step);
        },
      })
      .then((done) => {
        if (!done) return;
        if (done.status === "ready") void open(done);
        else
          setPhase({
            name: "stuck",
            workspace: done,
            error: done.error ?? "We could not start this workspace.",
            reason: "failed",
          });
      })
      .catch((e) => {
        if (!stop.signal.aborted)
          setPhase({ name: "stuck", workspace: making, error: message(e), reason: "other" });
      });
    return () => stop.abort();
  }, [control, makingId, open]);

  // The list shows workspaces coming up, so keep it fresh while any is.
  const waiting = phase.name === "home" && workspaces.some((w) => w.status === "provisioning");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void loadMe().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [waiting, loadMe]);

  // Coming back from Google, and links to join, as a phone delivers them.
  const finishGoogle = useCallback(
    async (code: string) => {
      setBusy(true);
      setError("");
      try {
        await control.exchangeLoginCode(code);
        await enter();
      } catch (e) {
        setError(message(e));
        setPhase({ name: "signed-out" });
      } finally {
        setBusy(false);
      }
    },
    [control, enter],
  );
  useEffect(() => {
    if (!onWeb) return;
    const expected = new URL(controlUrl).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expected) return;
      const code = (event.data as { hiveAuthCode?: unknown } | null)?.hiveAuthCode;
      if (typeof code === "string" && code) void finishGoogle(code);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [controlUrl, finishGoogle]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const handle = (url: string | null) => {
      if (!url) return;
      const code = url.match(/^hive:\/\/auth\?code=([^&]+)/)?.[1];
      if (code) {
        void finishGoogle(decodeURIComponent(code));
        return;
      }
      const token = inviteTokenFrom(url);
      if (token) {
        setInvite(token);
        setPreview(undefined);
        if (control.token) setPhase({ name: "join" });
      }
    };
    const subscription = Linking.addEventListener("url", ({ url }) => handle(url));
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    return () => subscription.remove();
  }, [control, finishGoogle]);

  const signInWithGoogle = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const { url } = await control.googleUrl(onWeb ? window.location.origin : undefined);
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
      setError(message(e));
      setBusy(false);
    }
  }, [control]);
  const signInByEmail = useCallback(
    async (email: string, name: string) => {
      setBusy(true);
      setError("");
      try {
        await control.signInByEmail(email, name);
        await enter();
      } catch (e) {
        setError(message(e));
        setPhase({ name: "signed-out" });
      } finally {
        setBusy(false);
      }
    },
    [control, enter],
  );

  const signOut = useCallback(async () => {
    try {
      await control.signOut();
    } catch {
      // The session is forgotten here either way.
    }
    await storage.remove(sessionKey);
    await storage.remove(lastKey);
    setAccount(null);
    setWorkspaces([]);
    setError("");
    setPhase({ name: "signed-out" });
  }, [control, sessionKey, lastKey]);
  const switchWorkspace = useCallback(
    async (about?: string) => {
      await storage.remove(lastKey);
      setNotice(about ?? "");
      await goHome();
    },
    [goHome, lastKey],
  );
  /** The account is gone on the control plane: forget everything here and say so on the sign-in screen. */
  const accountDeleted = useCallback(async () => {
    await storage.remove(sessionKey);
    await storage.remove(lastKey);
    setAccount(null);
    setWorkspaces([]);
    setError("");
    setDialog(null);
    setNotice("Your account was deleted.");
    setPhase({ name: "signed-out" });
  }, [sessionKey, lastKey]);
  const lost = useCallback(
    (why: string) => {
      setError(why);
      void switchWorkspace();
    },
    [switchWorkspace],
  );

  const create = useCallback(
    async (name: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const made = await control.createWorkspace(name);
        setWorkspaces((list) => [...list, made]);
        setPhase({ name: "making", workspace: made });
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    },
    [control],
  );
  const retry = useCallback(
    async (workspace: WorkspaceSummary) => {
      setError("");
      try {
        setPhase({ name: "making", workspace: await control.retry(workspace.id) });
      } catch (e) {
        setError(message(e));
      }
    },
    [control],
  );
  const accept = useCallback(async () => {
    const token = inviteRef.current;
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const joined = await control.acceptInvite(token);
      clearInvite();
      setWorkspaces((list) => [...list.filter((w) => w.id !== joined.id), joined]);
      await open(joined);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [control, clearInvite, open]);
  const dismissInvite = useCallback(() => {
    clearInvite();
    setError("");
    void goHome();
  }, [clearInvite, goHome]);

  const screen = () => {
    switch (phase.name) {
      case "boot":
        return <ProgressScreen title="Opening Hive…" />;
      case "offline":
        return (
          <ProgressScreen title="Hive is not reachable" error={phase.error}>
            <Button primary onPress={() => setBootCount((count) => count + 1)}>
              Try again
            </Button>
          </ProgressScreen>
        );
      case "signed-out":
        return (
          <SignInScreen
            options={options ?? { google: false, email: false }}
            invite={preview}
            busy={busy}
            error={error}
            notice={notice}
            onGoogle={() => void signInWithGoogle()}
            onEmail={(email, name) => void signInByEmail(email, name)}
          />
        );
      case "home":
        return account ? (
          <>
            <WorkspacesScreen
              account={account}
              workspaces={workspaces}
              maxWorkspaces={maxWorkspaces}
              error={error}
              busy={busy}
              onOpen={(workspace) => void open(workspace)}
              onCreate={(name) => void create(name)}
              onRetry={(workspace) => void retry(workspace)}
              onJoin={(token) => {
                setInvite(token);
                setPreview(undefined);
                setPhase({ name: "join" });
              }}
              onSignOut={() => void signOut()}
              onAccount={() => setDialog({ name: "account" })}
              onRemove={(workspace) => setDialog({ name: "remove", workspace })}
              notice={notice}
            />
            {dialog?.name === "account" && (
              <AccountSheet
                control={control}
                account={account}
                workspaces={workspaces}
                onClose={() => setDialog(null)}
                onSignOut={() => {
                  setDialog(null);
                  void signOut();
                }}
                onDeleted={() => void accountDeleted()}
                onOpenWorkspace={() => setDialog(null)}
              />
            )}
            {dialog?.name === "remove" && (
              <RemoveWorkspaceSheet
                workspace={dialog.workspace}
                control={control}
                accountId={account.id}
                onClose={() => setDialog(null)}
                onDone={(about) => {
                  setDialog(null);
                  void switchWorkspace(about);
                }}
              />
            )}
          </>
        ) : null;
      case "making":
        return <MakingScreen name={phase.workspace.name} step={makingStep} />;
      case "opening":
        return (
          <ProgressScreen
            moving
            title={`Opening ${phase.workspace.name}…`}
            detail={
              phase.step === "waking"
                ? "Waking your workspace up. If it was resting this can take a moment."
                : "Signing you in."
            }
          />
        );
      case "stuck":
        return (
          <ProgressScreen title={`Could not open ${phase.workspace.name}`} error={phase.error}>
            {phase.reason !== "gone" && phase.reason !== "failed" && (
              <Button primary onPress={() => void open(phase.workspace)}>
                Try again
              </Button>
            )}
            <Button
              primary={phase.reason === "gone" || phase.reason === "failed"}
              onPress={() => void goHome()}
            >
              Back to your workspaces
            </Button>
          </ProgressScreen>
        );
      case "join":
        return (
          <JoinScreen
            preview={preview ?? null}
            error={error}
            busy={busy || preview === undefined}
            onJoin={() => void accept()}
            onCancel={dismissInvite}
          />
        );
      case "workspace":
        return account ? (
          <HostedWorkspace
            key={phase.opened.workspace.id}
            control={control}
            account={account}
            initial={phase.opened}
            onSwitch={(about) => void switchWorkspace(about)}
            onSignOut={signOut}
            onAccountDeleted={() => void accountDeleted()}
            onLost={lost}
          />
        ) : null;
    }
  };
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen()}
    </SafeAreaProvider>
  );
}
