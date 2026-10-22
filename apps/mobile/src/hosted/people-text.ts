import type { InviteSummary, Role } from "./control-api";

export const roleLabel: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** What being a guest comes to, said wherever someone chooses it. */
export const guestHint =
  "A guest sees only these channels, and nothing else in the workspace. You can change them later.";

/** What an invitation is for, as the words after "invited you". */
export function invitedAs(role: string): string {
  return role === "admin" ? " as an admin" : role === "guest" ? " as a guest" : "";
}

const DAY = 24 * 60 * 60 * 1000;

/** How long an invitation has left, in words. */
export function expiresIn(expiresAt: number, now = Date.now()): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  const days = Math.ceil(left / DAY);
  if (days <= 1) return "expires today";
  if (days === 2) return "expires tomorrow";
  return `expires in ${days} days`;
}

/** A pending invitation as a line in a list: what it is, and what is left of it. */
export function describeInvite(
  invite: InviteSummary,
  now = Date.now(),
): { title: string; detail: string } {
  const role = invite.role === "admin" ? "Admin · " : invite.role === "guest" ? "Guest · " : "";
  if (invite.email)
    return { title: invite.email, detail: `${role}${expiresIn(invite.expiresAt, now)}` };
  return {
    title: "Invite link",
    detail: `${role}${invite.uses} of ${invite.maxUses} used · ${expiresIn(invite.expiresAt, now)}`,
  };
}
