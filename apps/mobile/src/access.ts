import { useHosted } from "./hosted/context";

/**
 * Whether this person is a guest. A guest can open only the channels they were added to: no
 * orchestrator chat, and none of the workspace's mail, calendar, files or goals. The server holds
 * them to it; the app only leaves out what they could not use.
 */
export function useGuest(): boolean {
  return useHosted()?.user.role === "guest";
}

/** Whether this person chooses who is in a channel: the owner and admins of a hosted workspace. */
export function useManagesAccess(): boolean {
  const role = useHosted()?.user.role;
  return role === "owner" || role === "admin";
}
