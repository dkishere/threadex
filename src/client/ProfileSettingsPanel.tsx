import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { AccountRecord, ProfileAnalytics, WorkspaceRecord } from "./appTypes";

export function ProfileSettingsPanel({
  analytics,
  error,
  isLoading,
  workspaceId,
  workspaces,
  accountId,
  onWorkspaceChange,
  onAccountChange
}: {
  analytics: ProfileAnalytics | null;
  error: string;
  isLoading: boolean;
  workspaceId: string;
  workspaces: WorkspaceRecord[];
  accountId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onAccountChange: (accountId: string) => void;
}) {
  const workspace = analytics?.workspace ?? workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const summary = analytics?.summary ?? {};
  const activityDays = buildProfileActivityDays(analytics?.activity ?? []);
  const streaks = profileActivityStreaks(activityDays);
  const totalReasoningUses = (analytics?.reasoning ?? []).reduce((total, item) => total + Number(item.uses || 0), 0);
  const mostUsedReasoning = analytics?.reasoning?.[0];
  const totalSkillUses = (analytics?.skills ?? []).reduce((total, item) => total + Number(item.uses || 0), 0);
  const initials = workspaceInitials(workspace?.name ?? "Workspace");

  return (
    <div className="settings-content profile-settings" role="tabpanel" aria-label="Profile">
      <div className="profile-workspace-bar">
        <label htmlFor="profile-workspace-select">Workspace</label>
        <select
          id="profile-workspace-select"
          value={workspaceId}
          onChange={(event) => onWorkspaceChange(event.target.value)}
        >
          {workspaces.map((candidate) => (
            <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
          ))}
        </select>
        {isLoading && <Loader2 className="spin profile-loading-icon" aria-label="Refreshing profile" />}
      </div>

      {error && !analytics ? <div className="profile-error">{error}</div> : null}
      {!analytics && isLoading ? (
        <div className="profile-loading-card" aria-label="Loading profile analytics">
          <Loader2 className="spin" aria-hidden="true" />
          Loading workspace activity…
        </div>
      ) : null}

      {analytics ? (
        <>
          {error ? <div className="profile-error">Showing the last available data. Refresh failed: {error}</div> : null}
          <section className="settings-card profile-hero" aria-labelledby="profile-workspace-name">
            <div className="profile-identity">
              <span className="profile-avatar" aria-hidden="true">{initials}</span>
              <div>
                <h2 id="profile-workspace-name">{workspace?.name ?? "Workspace"}</h2>
                <p>{workspace?.cwd ?? ""}</p>
              </div>
            </div>
            <div className="profile-metrics">
              <ProfileMetric value={formatProfileTokenCount(summary.lifetime_tokens)} label="Lifetime tokens" />
              <ProfileMetric value={formatProfileTokenCount(summary.peak_tokens)} label="Peak day" />
              <ProfileMetric value={formatProfileDuration(summary.longest_task_seconds)} label="Longest task" />
              <ProfileMetric value={`${streaks.current} day${streaks.current === 1 ? "" : "s"}`} label="Current streak" />
              <ProfileMetric value={`${streaks.longest} day${streaks.longest === 1 ? "" : "s"}`} label="Longest streak" />
            </div>
          </section>

          <section className="profile-account-filter" aria-labelledby="profile-account-filter-title">
            <div>
              <h3 id="profile-account-filter-title">Account details</h3>
              <p>Filter every metric below by account.</p>
            </div>
            <div className="profile-filter-tabs" role="tablist" aria-label="Account details filter">
              <button
                type="button"
                role="tab"
                aria-selected={!accountId}
                data-active={!accountId}
                onClick={() => onAccountChange("")}
              >
                All
              </button>
              {analytics.accounts.map((account) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={accountId === account.id}
                  data-active={accountId === account.id}
                  onClick={() => onAccountChange(account.id)}
                  key={account.id}
                  title={account.email || account.externalAccountId || account.name}
                >
                  {account.name}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-card profile-activity-card" aria-labelledby="profile-activity-title">
            <div className="profile-card-heading">
              <div>
                <h3 id="profile-activity-title">Token activity</h3>
                <p>Daily activity over the last 365 days.</p>
              </div>
              <span>{summary.active_days ?? 0} active days</span>
            </div>
            <ProfileActivityGrid days={activityDays} />
          </section>

          <section className="settings-card profile-chart-card" aria-labelledby="profile-token-trend-title">
            <div className="profile-card-heading profile-chart-heading">
              <div>
                <h3 id="profile-token-trend-title">10-day model usage</h3>
                <p>Uncached input, cached input, and output tokens per recorded model.</p>
              </div>
              <div className="profile-line-key" aria-label="Line styles">
                <span><i /> Uncached input</span>
                <span><i data-dotted="true" /> Cached</span>
                <span><i data-dashed="true" /> Output</span>
              </div>
            </div>
            <ProfileTokenUsageChart key={`${workspaceId}\u0000${accountId}`} trend={analytics.trend} />
          </section>

          <div className="profile-insight-grid">
            <section className="settings-card profile-insight-card" aria-labelledby="profile-insights-title">
              <div className="profile-card-heading">
                <div><h3 id="profile-insights-title">Activity insights</h3></div>
              </div>
              <dl>
                <div><dt>Most used reasoning</dt><dd>{mostUsedReasoning ? `${titleCase(mostUsedReasoning.effort)} · ${Math.round((mostUsedReasoning.uses / Math.max(1, totalReasoningUses)) * 100)}%` : "Not recorded"}</dd></div>
                <div><dt>Models used</dt><dd>{summary.models_used ?? 0}</dd></div>
                <div><dt>Skills explored</dt><dd>{analytics.skills.length}</dd></div>
                <div><dt>Total skill uses</dt><dd>{totalSkillUses}</dd></div>
                <div><dt>Total tasks</dt><dd>{Number(summary.total_tasks ?? 0).toLocaleString()}</dd></div>
                <div><dt>Total sessions</dt><dd>{Number(summary.total_sessions ?? 0).toLocaleString()}</dd></div>
              </dl>
            </section>

            <section className="settings-card profile-insight-card" aria-labelledby="profile-skills-title">
              <div className="profile-card-heading">
                <div>
                  <h3 id="profile-skills-title">Most used skills</h3>
                  <p>Explicitly selected skills are tracked from now on.</p>
                </div>
              </div>
              {analytics.skills.length ? (
                <ol className="profile-skill-list">
                  {analytics.skills.slice(0, 6).map((skill) => (
                    <li key={skill.name}><span>{skill.name}</span><strong>{skill.uses} use{skill.uses === 1 ? "" : "s"}</strong></li>
                  ))}
                </ol>
              ) : (
                <p className="profile-no-skills">No explicitly selected skills recorded yet.</p>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ProfileMetric({ value, label }: { value: string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

type ProfileActivityDay = { date: string; tokens: number; tasks: number; level: number };

function ProfileActivityGrid({ days }: { days: ProfileActivityDay[] }) {
  return (
    <div className="profile-activity-scroll">
      <div className="profile-activity-grid" role="img" aria-label="Daily token activity heatmap for the last 365 days">
        {days.map((day) => (
          <span
            key={day.date}
            data-level={day.level}
            title={`${formatProfileDate(day.date)} · ${formatProfileTokenCount(day.tokens)} tokens · ${day.tasks} task${day.tasks === 1 ? "" : "s"}`}
          />
        ))}
      </div>
      <div className="profile-activity-labels" aria-hidden="true">
        <span>{formatProfileMonth(days[0]?.date)}</span>
        <span>365 days</span>
        <span>{formatProfileMonth(days.at(-1)?.date)}</span>
      </div>
    </div>
  );
}

function ProfileTokenUsageChart({ trend }: { trend: ProfileAnalytics["trend"] }) {
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set());
  const dates = lastProfileDates(10);
  const models = [...new Set(trend.map((item) => item.model).filter(Boolean))]
    .sort((left, right) => modelTrendTotal(trend, right) - modelTrendTotal(trend, left));
  const visibleModels = models.filter((model) => !hiddenModels.has(model));
  const visibleTrend = trend.filter((item) => !hiddenModels.has(item.model));
  const rows = new Map(trend.map((item) => [`${item.date}\u0000${item.model}`, item]));
  const uncachedInputTokens = (item: ProfileAnalytics["trend"][number] | undefined) => Math.max(
    0,
    (Number(item?.input_tokens) || 0) - (Number(item?.cached_input_tokens) || 0)
  );
  const maxTokens = Math.max(
    1,
    ...visibleTrend.flatMap((item) => [
      uncachedInputTokens(item),
      Number(item.cached_input_tokens) || 0,
      Number(item.output_tokens) || 0
    ])
  );
  const left = 66;
  const right = 796;
  const top = 24;
  const bottom = 216;
  const x = (index: number) => left + (index / Math.max(1, dates.length - 1)) * (right - left);
  const tokenY = (tokens: number) => bottom - (tokens / maxTokens) * (bottom - top);
  const colors = models.map((_, index) => `hsl(${(index * 67 + 213) % 360} 72% 48%)`);

  if (models.length === 0) {
    return <div className="profile-chart-empty">No model usage recorded in the last 10 days.</div>;
  }

  return (
    <div className="profile-chart-wrap">
      <svg width="830" height="270" viewBox="0 0 830 270" role="img" aria-label="Ten day model uncached input, cached input, and output token usage chart">
        <title>10-day model uncached input, cached input, and output token usage</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = bottom - ratio * (bottom - top);
          return (
            <g key={ratio}>
              <line x1={left} x2={right} y1={y} y2={y} className="profile-chart-gridline" />
              <text x={left - 9} y={y + 4} textAnchor="end" className="profile-chart-axis">{formatProfileTokenCount(maxTokens * ratio)}</text>
            </g>
          );
        })}
        {dates.map((date, index) => (
          <text key={date} x={x(index)} y="244" textAnchor="middle" className="profile-chart-date">{formatProfileChartDate(date)}</text>
        ))}
        {visibleModels.map((model) => {
          const modelIndex = models.indexOf(model);
          const values = dates.map((date) => rows.get(`${date}\u0000${model}`));
          const uncachedInputPoints = values.map((value, index) => `${x(index)},${tokenY(uncachedInputTokens(value))}`).join(" ");
          const cachedInputPoints = values.map((value, index) => `${x(index)},${tokenY(Number(value?.cached_input_tokens) || 0)}`).join(" ");
          const outputPoints = values.map((value, index) => `${x(index)},${tokenY(Number(value?.output_tokens) || 0)}`).join(" ");
          return (
            <g key={model}>
              <polyline points={uncachedInputPoints} fill="none" stroke={colors[modelIndex]} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={cachedInputPoints} fill="none" stroke={colors[modelIndex]} strokeWidth="1.35" strokeDasharray="1 5" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={outputPoints} fill="none" stroke={colors[modelIndex]} strokeWidth="1.35" strokeDasharray="5 5" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
      </svg>
      <div className="profile-model-legend" aria-label="Models shown in chart">
        {models.map((model, index) => (
          <label key={model}>
            <input
              type="checkbox"
              checked={!hiddenModels.has(model)}
              style={{ accentColor: colors[index] }}
              onChange={() => setHiddenModels((current) => {
                const next = new Set(current);
                if (next.has(model)) next.delete(model);
                else next.add(model);
                return next;
              })}
            />
            {model}
          </label>
        ))}
      </div>
    </div>
  );
}

function buildProfileActivityDays(activity: ProfileAnalytics["activity"]): ProfileActivityDay[] {
  const activityByDate = new Map(activity.map((item) => [item.date, item]));
  const dates = lastProfileDates(365);
  const maxTokens = Math.max(1, ...activity.map((item) => Number(item.tokens) || 0));
  return dates.map((date) => {
    const item = activityByDate.get(date);
    const tokens = Number(item?.tokens) || 0;
    return {
      date,
      tokens,
      tasks: Number(item?.tasks) || 0,
      level: tokens > 0 ? Math.max(1, Math.ceil((Math.log1p(tokens) / Math.log1p(maxTokens)) * 4)) : 0
    };
  });
}

function profileActivityStreaks(days: ProfileActivityDay[]) {
  let current = 0;
  for (let index = days.length - 1; index >= 0 && days[index].tasks > 0; index -= 1) current += 1;

  let longest = 0;
  let running = 0;
  for (const day of days) {
    running = day.tasks > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }
  return { current, longest };
}

function lastProfileDates(count: number) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (count - index - 1));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
}

function formatProfileTokenCount(value: number | undefined) {
  const numeric = Number(value) || 0;
  if (numeric >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(numeric).toLocaleString();
}

function formatProfileDuration(value: number | undefined) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function workspaceInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || "WS").toUpperCase();
}

function modelTrendTotal(trend: ProfileAnalytics["trend"], model: string) {
  return trend.reduce((total, item) => total + (item.model === model ? Number(item.tokens) || 0 : 0), 0);
}

function titleCase(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function profileDateValue(value: string | undefined) {
  return value ? new Date(`${value}T12:00:00`) : null;
}

function formatProfileDate(value: string) {
  const date = profileDateValue(value);
  return date ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date) : value;
}

function formatProfileMonth(value: string | undefined) {
  const date = profileDateValue(value);
  return date ? new Intl.DateTimeFormat(undefined, { month: "short" }).format(date) : "";
}

function formatProfileChartDate(value: string) {
  const date = profileDateValue(value);
  return date ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date) : value;
}
