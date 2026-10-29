// Usage samples contain both the latest model request and a thread-wide counter.
// Sum counter deltas within each turn, seeding with the first request rather
// than charging the thread's earlier turns. Repeated notifications add zero;
// a counter reset starts a new segment. Never add different telemetry sources.
export const turnTokenUsageJoinSql = `
  LEFT JOIN LATERAL (
    WITH samples AS (
      SELECT source, input_tokens, cached_input_tokens, output_tokens,
        cumulative_input_tokens, cumulative_cached_input_tokens, cumulative_output_tokens,
        lag(cumulative_input_tokens) OVER sample_order AS previous_input,
        lag(cumulative_cached_input_tokens) OVER sample_order AS previous_cached,
        lag(cumulative_output_tokens) OVER sample_order AS previous_output
      FROM token_usage
      WHERE turn_id = session_turn.id AND usage_type = 'agent'
        AND source IN ('app_server', 'native_token_count')
        AND (cumulative_input_tokens > 0 OR cumulative_output_tokens > 0)
      WINDOW sample_order AS (PARTITION BY source
        ORDER BY source_timestamp NULLS LAST, source_index NULLS LAST, created, id)
    )
    SELECT
      sum(CASE WHEN previous_input IS NULL OR cumulative_input_tokens < previous_input
        THEN input_tokens ELSE cumulative_input_tokens - previous_input END) AS input_tokens,
      sum(CASE WHEN previous_cached IS NULL OR cumulative_cached_input_tokens < previous_cached
        THEN cached_input_tokens ELSE cumulative_cached_input_tokens - previous_cached END) AS cached_input_tokens,
      sum(CASE WHEN previous_output IS NULL OR cumulative_output_tokens < previous_output
        THEN output_tokens ELSE cumulative_output_tokens - previous_output END) AS output_tokens
    FROM samples
    GROUP BY source
    ORDER BY CASE source WHEN 'app_server' THEN 0 ELSE 1 END
    LIMIT 1
  ) AS turn_usage_totals ON TRUE
`;

// Subagents keep their own counters, so apply the same delta rule per agent
// and add the agents together. They never contribute to turn_usage_totals.
// Some sources (Claude background tasks) report only a total.
export const turnSubagentTokenUsageJoinSql = `
  LEFT JOIN LATERAL (
    WITH samples AS (
      SELECT input_tokens, cached_input_tokens, output_tokens, total_tokens,
        cumulative_input_tokens, cumulative_cached_input_tokens, cumulative_output_tokens, cumulative_total_tokens,
        json_extract_string(metadata, '$.agentId') AS agent_id,
        lag(cumulative_input_tokens) OVER sample_order AS previous_input,
        lag(cumulative_cached_input_tokens) OVER sample_order AS previous_cached,
        lag(cumulative_output_tokens) OVER sample_order AS previous_output,
        lag(cumulative_total_tokens) OVER sample_order AS previous_total
      FROM token_usage
      WHERE turn_id = session_turn.id AND usage_type = 'subagent'
        AND (cumulative_input_tokens > 0 OR cumulative_output_tokens > 0 OR cumulative_total_tokens > 0)
      WINDOW sample_order AS (PARTITION BY source, json_extract_string(metadata, '$.agentId')
        ORDER BY source_timestamp NULLS LAST, source_index NULLS LAST, created, id)
    )
    SELECT
      sum(CASE WHEN previous_input IS NULL OR cumulative_input_tokens < previous_input
        THEN input_tokens ELSE cumulative_input_tokens - previous_input END) AS input_tokens,
      sum(CASE WHEN previous_cached IS NULL OR cumulative_cached_input_tokens < previous_cached
        THEN cached_input_tokens ELSE cumulative_cached_input_tokens - previous_cached END) AS cached_input_tokens,
      sum(CASE WHEN previous_output IS NULL OR cumulative_output_tokens < previous_output
        THEN output_tokens ELSE cumulative_output_tokens - previous_output END) AS output_tokens,
      sum(CASE WHEN previous_total IS NULL OR cumulative_total_tokens < previous_total
        THEN total_tokens ELSE cumulative_total_tokens - previous_total END) AS total_tokens,
      count(DISTINCT agent_id) AS agent_count
    FROM samples
  ) AS turn_subagent_usage_totals ON TRUE
`;
