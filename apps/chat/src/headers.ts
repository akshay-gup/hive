/** The header the Worker puts on what it hands the room: who is asking, once it has checked. */
export const IDENTITY_HEADER = "x-hive-identity";
/** The header that marks a request as one of the control plane's, once the Worker has checked its token. */
export const INTERNAL_HEADER = "x-hive-internal";
/** The header that marks a connection as the agent's machine, once the Worker has checked its token: when the token runs out. */
export const RUNNER_HEADER = "x-hive-runner";
