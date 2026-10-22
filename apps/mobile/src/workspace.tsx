import { createContext, useContext } from "react";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
  EventDraft,
  Mail,
  Section,
  Workspace,
} from "../../../packages/domain/src";
import type { MuseApi } from "./api";
export type Detail =
  | { type: "mail"; mail: Mail }
  | { type: "email"; draft?: Partial<EmailDraft> & { id?: string } }
  | { type: "event"; event?: CalendarEvent; draft?: EventDraft; neighbors?: CalendarEvent[] }
  | { type: "file"; file: Artifact }
  | { type: "browser"; browser: BrowserSession }
  | { type: "review"; action: ActionProposal }
  | { type: "task"; taskId: string }
  | { type: "channelFiles"; channelId: string; name?: string; path?: string }
  | { type: "channelFile"; channelId: string; path: string }
  | { type: "channelMembers"; channelId: string; name?: string }
  | { type: "delegate"; threadId?: string }
  | { type: "notifications" }
  | { type: "computer" }
  | { type: "people" }
  | { type: "account" }
  | { type: "menu" };
export interface WorkspaceContextValue {
  workspace: Workspace;
  api: MuseApi;
  section: Section;
  navigate: (section: Section) => void;
  refresh: () => Promise<void>;
  open: (detail: Detail) => void;
  close: () => void;
  notify: (message: string) => void;
  ask: (prompt: string) => void;
  logout: () => Promise<void>;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable");
  return context;
}
