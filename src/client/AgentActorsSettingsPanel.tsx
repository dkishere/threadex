import { useState } from "react";
import type { ActorSummary } from "../domainActors";
import { ACTOR_TYPE_LABELS } from "../actorTypes";
import { WorkerSettingsPanel } from "./WorkerSettingsPanel";
import { RoundtableActorsPanel } from "./RoundtableActorsPanel";

export function AgentActorsSettingsPanel({ workspaceId, workspaceName, summary, error, authRequired, onSelectActor, onOpenRoom }: {
  workspaceId?: string;
  workspaceName: string; summary: ActorSummary | null; error: string | null; authRequired: boolean;
  onSelectActor: (id: string) => void; onOpenRoom: (chatKey: string) => void;
}) {
  const [type, setType] = useState<"worker" | "consultant">("consultant");
  return <section className="settings-content" role="tabpanel" aria-label="Agent actors">
    <div className="settings-section-heading"><div><h2>Agent actors</h2><p>Workers carry out tasks in your workspace. Consultants provide reusable perspectives.</p></div></div>
    <div className="sidebar-view-tabs" role="group" aria-label="Actor type">
      {(["worker", "consultant"] as const).map(value => <button type="button" key={value}
        aria-pressed={type === value} onClick={() => setType(value)}>{ACTOR_TYPE_LABELS[value]}</button>)}
    </div>
    <div hidden={type !== "consultant"}><RoundtableActorsPanel embedded /></div>
    {type === "worker" && (workspaceId || summary?.workspaceId ? <WorkerSettingsPanel key={workspaceId ?? summary!.workspaceId}
      workspaceId={workspaceId ?? summary!.workspaceId} workspaceName={workspaceName} onOpen={onSelectActor} onOpenRoom={onOpenRoom} />
      : <p role={error || authRequired ? "alert" : "status"}>{authRequired ? "Sign in to configure workers." : error || "Loading workspace…"}</p>)}
  </section>;
}
