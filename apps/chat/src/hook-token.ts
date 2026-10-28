import { createHmac, timingSafeEqual } from "node:crypto";

/** What proves an address for a routine's web hook is the one the room made: made from the workspace, the routine and a number that changes when the address is changed. */
const mac = (key: string, workspaceId: string, routineId: string, epoch: number) =>
  createHmac("sha256", key)
    .update(["hook", workspaceId, routineId, epoch].join("\n"))
    .digest("base64url");

export const makeHookToken = (key: string, workspaceId: string, routineId: string, epoch: number) =>
  mac(key, workspaceId, routineId, epoch);

export function checkHookToken(
  key: string,
  workspaceId: string,
  routineId: string,
  epoch: number,
  given: string,
): boolean {
  const expected = Buffer.from(mac(key, workspaceId, routineId, epoch));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
