import { createContext, useContext, type ReactNode } from "react";

type CurrentActor = Readonly<{ id: string; name: string; avatar?: string }>;
type CurrentActors = Readonly<{ workspaceId: string; actors: readonly CurrentActor[] }>;

const CurrentDomainActorsContext = createContext<CurrentActors | null>(null);

/** Reuses the shell's summary, and discards it immediately when changing workspace. */
export function CurrentDomainActorsProvider({ workspaceId, summary, children }: {
  workspaceId?: string;
  summary: CurrentActors | null;
  children: ReactNode;
}) {
  const current = workspaceId && summary?.workspaceId === workspaceId ? summary : null;
  return <CurrentDomainActorsContext.Provider value={current}>{children}</CurrentDomainActorsContext.Provider>;
}

export function useCurrentDomainActors() {
  return useContext(CurrentDomainActorsContext);
}
