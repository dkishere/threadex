export type QuickChatAccount = { id: string; label: string };
export type QuickChatModel = { id: string; label: string };
export type QuickChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type QuickChatSession = { id: string; accountId: string; title: string; messages: QuickChatMessage[]; interrupted?: boolean };
export type QuickChatStatus = { accounts: QuickChatAccount[]; models: QuickChatModel[]; error?: string };
