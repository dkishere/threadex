import { outcomeProgress, type LightweightTodo, type OutcomeItem } from "../lightweightTodo";

const labels = { pending: "Pending", active: "In progress", unverified: "Not yet verified", done: "Verified", blocked: "Blocked" };

export function LightweightTodoPanel({ plan }: { plan: LightweightTodo }) {
  function render(item: OutcomeItem) {
    const progress = outcomeProgress(plan, item);
    return <li key={item.id} data-status={progress.status}>
      <details open>
        <summary><span>{item.title}</span><span className="outcome-status">{labels[progress.status]}</span></summary>
        <p className="outcome-acceptance">{item.acceptance}</p>
        {progress.note && <p>{progress.note}</p>}
        {progress.sources.length > 0 && <details className="outcome-evidence"><summary>Evidence sources</summary><ul>{progress.sources.map((source) => <li key={source}><code>{source}</code></li>)}</ul></details>}
        {item.children.length > 0 && <ul>{item.children.map(render)}</ul>}
      </details>
    </li>;
  }
  return <section className="lightweight-todo" aria-label="Outcome plan">
    <details open>
      <summary><strong>{plan.objective || "Outcome plan"}</strong><span>Todo</span></summary>
      {!plan.sourceHash && <p className="outcome-acceptance">Status will update after the agent finishes this turn.</p>}
      <ul>{plan.items.map(render)}</ul>
    </details>
  </section>;
}
