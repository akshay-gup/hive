import { createContext } from "react";

/** Whether the agent is working, and whether the reply being drawn is the one it is working on. */
export const BrowserRunContext = createContext({ running: false, active: false });
