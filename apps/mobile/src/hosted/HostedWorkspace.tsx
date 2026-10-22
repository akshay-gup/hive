import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { MuseApi } from "../api-client";
import { WorkspaceApp } from "../workspace-app";
import { HostedContext, type HostedContextValue } from "./context";
import type { ControlAccount, ControlApi } from "./control-api";
import {
  type OpenedWorkspace,
  renewSession,
  shouldRenew,
  WorkspaceUnavailable,
} from "./open-workspace";

/** How old a session may get before it is made again, so a changed role arrives. */
const ROLE_REFRESH_MS = 5 * 60 * 1000;
/** The same, when the person comes back to the app. */
const ROLE_REFRESH_ON_RETURN_MS = 60 * 1000;

/**
 * A workspace the person has been signed in to. Its session lasts an hour, so this signs in again
 * through the control plane before that ends, and when the workspace refuses the session
 * anyway, without the person seeing any of it. If they have lost their place in the workspace
 * it says so and lets them go.
 */
export function HostedWorkspace({
  control,
  account,
  initial,
  onSwitch,
  onSignOut,
  onAccountDeleted,
  onLost,
}: {
  control: ControlApi;
  account: ControlAccount;
  initial: OpenedWorkspace;
  onSwitch: (notice?: string) => void;
  onSignOut: () => Promise<void>;
  onAccountDeleted: () => void;
  /** The person can no longer be in this workspace. */
  onLost: (message: string) => void;
}) {
  const [opened, setOpened] = useState(initial);
  const current = useRef(initial);
  const renewing = useRef<Promise<string | null> | null>(null);
  // When the session was last made, so a change of role is picked up soon after it is made.
  const signedAt = useRef(Date.now());
  // One API object for as long as the workspace is open, so what holds it is not rebuilt at each renewal.
  const api = useMemo(() => new MuseApi(initial.token, initial.url), [initial]);

  const renew = useCallback((): Promise<string | null> => {
    if (!renewing.current)
      renewing.current = renewSession(control, current.current)
        .then((next) => {
          current.current = next;
          signedAt.current = Date.now();
          api.token = next.token;
          setOpened(next);
          return next.token;
        })
        .catch((error) => {
          if (error instanceof WorkspaceUnavailable && error.reason === "gone")
            onLost(error.message);
          return null;
        })
        .finally(() => {
          renewing.current = null;
        });
    return renewing.current;
  }, [api, control, onLost]);

  useEffect(() => {
    api.renew = renew;
    // The role a person has is the one the workspace was told when they last signed in, so a
    // session is made again every few minutes, and as soon as they come back to the app after a
    // while, not only when it is about to end.
    const check = (staleAfter: number) => {
      if (shouldRenew(current.current) || Date.now() - signedAt.current > staleAfter) void renew();
    };
    const timer = setInterval(() => check(ROLE_REFRESH_MS), 60_000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") check(ROLE_REFRESH_ON_RETURN_MS);
    });
    return () => {
      api.renew = undefined;
      clearInterval(timer);
      listener.remove();
    };
  }, [api, renew]);

  const hosted = useMemo<HostedContextValue>(
    () => ({
      control,
      workspace: opened.workspace,
      account,
      user: opened.user,
      switchWorkspace: onSwitch,
      signOut: onSignOut,
      accountDeleted: onAccountDeleted,
    }),
    [control, opened.workspace, opened.user, account, onSwitch, onSignOut, onAccountDeleted],
  );
  return (
    <HostedContext.Provider value={hosted}>
      <CopilotKitProvider
        runtimeUrl={`${opened.url}/api/copilotkit`}
        headers={{ Authorization: `Bearer ${opened.token}` }}
      >
        <WorkspaceApp
          api={api}
          identity={`${initial.workspace.id}:${initial.user.id}`}
          logout={onSignOut}
        />
      </CopilotKitProvider>
    </HostedContext.Provider>
  );
}
