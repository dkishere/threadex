import { Loader2 } from "lucide-react";

/** Spinner and heading shown inside `.empty` while a session transcript is loading, wherever the session is opened from. */
export function SessionLoadingIndicator({ label = "Loading session" }: { label?: string }) {
  return <>
    <Loader2 className="spin" aria-hidden="true" />
    <h2>{label}</h2>
  </>;
}
