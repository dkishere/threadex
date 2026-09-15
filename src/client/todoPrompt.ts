type DeveloperInstructionRecord = {
  developerInstructions: string;
};

const TODO_PLAN_GATE_START = "[TODO MCP PLAN COMPLETION AND MUTATION GATE";
const TODO_PLAN_GATE_PATTERN =
  /\[TODO MCP PLAN COMPLETION AND MUTATION GATE[^\]\n]*\][\s\S]*?\[END TODO MCP PLAN COMPLETION AND MUTATION GATE\]/;

export function extractTodoMcpPromptBlocks(value: string | null | undefined) {
  if (!value) {
    return [];
  }

  const gateMatch = value.match(TODO_PLAN_GATE_PATTERN);
  const composerMatch = gateMatch ?? value.match(
    /(?:User prompted you to create a Todo MCP plan for this turn\.|Composer Todo MCP plan mode is active for this turn:)[\s\S]*?(?=\n\n|$)/
  );
  if (!composerMatch?.[0]) {
    return [];
  }

  const parts = gateMatch
    ? [gateMatch[0]
        .replace(/^\[TODO MCP PLAN COMPLETION AND MUTATION GATE[^\]\n]*\]\n?/, "")
        .replace(/\n?\[END TODO MCP PLAN COMPLETION AND MUTATION GATE\]$/, "")]
    : [composerMatch[0]];

  if (!gateMatch) {
    const plannerMatch = value.match(
      /(?:This is a Todo planning agent\.|Todo planner:)[\s\S]*?(?=\nFor all generated todo text|\nFor all agent-generated todo content|\nUse list_processes|$)/
    );
    if (plannerMatch?.[0]) {
      parts.push(plannerMatch[0]);
    }
  }

  const languageMatch = value.match(
    /(?:For all generated todo text|For all agent-generated todo content),[\s\S]*?(?=\nUse list_processes|$)/
  );
  if (languageMatch?.[0]) {
    parts.push(languageMatch[0]);
  }

  return [`[TODO MCP PLAN]\n${parts.join("\n\n")}\n[END TODO MCP PLAN]`];
}

export function isTodoMcpPromptText(value: string) {
  return value.includes("[TODO MCP PLAN]") ||
    value.includes(TODO_PLAN_GATE_START) ||
    value.includes("Todo MCP plan mode") ||
    value.includes("Todo planning agent");
}

export function developerInstructionsIndicateForcePlan(
  records: DeveloperInstructionRecord[] | null | undefined
) {
  return (records ?? []).some(({ developerInstructions }) =>
    developerInstructions.includes(TODO_PLAN_GATE_START) ||
    developerInstructions.includes("Lightweight Todo harness is active.") ||
    developerInstructions.includes("User prompted you to create a Todo MCP plan for this turn.") ||
    developerInstructions.includes("Composer Todo MCP plan mode is active for this turn:")
  );
}
