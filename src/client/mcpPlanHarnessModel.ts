export type TaskStatus = "queued" | "running" | "writing" | "waiting" | "blocked" | "completed";
export type TaskKind = "plan" | "task" | "subtask" | "sub-agent";

export type MockTask = {
  id: string;
  title: string;
  kind: TaskKind;
  owner: string;
  tool: string;
  description: string;
  filePath: string;
  fileContent: string;
  children?: MockTask[];
  challenge?: {
    title: string;
    symptom: string;
    solution: string;
    outcome: "self-resolve" | "blocker";
    workaround?: string;
  };
};

export type TaskState = {
  status: TaskStatus;
  detail: string;
  progress: number;
  updatedAt: number;
};

export type HarnessEvent = {
  id: string;
  taskId: string;
  taskTitle: string;
  actor: string;
  message: string;
  tone: "neutral" | "active" | "success" | "warning";
  time: number;
};

export type MockFile = {
  path: string;
  content: string;
  updatedAt: number;
  taskId: string;
  version: number;
};

export const ROOT_ID = "release-orchestrator";

export const MOCK_PLAN: MockTask = {
  id: ROOT_ID,
  title: "Release orchestrator · nested MCP plan",
  kind: "plan",
  owner: "planner",
  tool: "mcp.plan",
  description: "A dry-run release workflow with nested research, implementation, and verification agents.",
  filePath: "mock-plan/release-plan.json",
  fileContent: "{\n  \"mode\": \"mock\",\n  \"executeMcp\": false,\n  \"children\": 4\n}"
  ,
  children: [
    {
      id: "discover",
      title: "Discover repository + MCP capabilities",
      kind: "task",
      owner: "scout",
      tool: "mcp.tools.list",
      description: "Read the available tool surface and establish a safe execution boundary.",
      filePath: "mock-plan/capabilities.json",
      fileContent: "{\n  \"tools\": [\"filesystem.read\", \"filesystem.patch\", \"agent.spawn\"],\n  \"realExecution\": false\n}"
    },
    {
      id: "design",
      title: "Design the harness state machine",
      kind: "task",
      owner: "architect",
      tool: "mcp.plan.compose",
      description: "Turn the desired user journey into observable task states and hand-offs.",
      filePath: "mock-plan/state-machine.md",
      fileContent: "# Harness states\n\nqueued → planning → tool call → writing → waiting → completed"
      ,
      children: [
        {
          id: "map-mcp",
          title: "Map MCP tool contracts",
          kind: "subtask",
          owner: "architect",
          tool: "mcp.schema.inspect",
          description: "Validate the shape of mocked tool calls before a child agent uses them.",
          filePath: "mock-plan/tool-contracts.json",
          fileContent: "{\n  \"filesystem.patch\": {\"input\": \"path, patch\", \"sideEffect\": \"mock-only\"}\n}",
          challenge: {
            title: "Schema drift in filesystem.patch",
            symptom: "The child agent emits `file` while the mock contract expects `path`.",
            solution: "Agent normalized `file` to `path` at the plan boundary and continued.",
            outcome: "self-resolve"
          }
        },
        {
          id: "sketch-ui",
          title: "Sketch observable UI states",
          kind: "subtask",
          owner: "product-agent",
          tool: "mcp.ui.snapshot",
          description: "Define what a human should see while each nested task is progressing.",
          filePath: "mock-plan/ui-observability.md",
          fileContent: "# Observable states\n\n- task tree\n- event stream\n- mock file writes\n- challenge + solution"
        }
      ]
    },
    {
      id: "implement",
      title: "Implement mock execution surface",
      kind: "task",
      owner: "builder",
      tool: "mcp.agent.delegate",
      description: "Build the simulated executor and the controls that drive it.",
      filePath: "mock-plan/implementation.md",
      fileContent: "# Implementation\n\nExecutor: in-memory\nMCP calls: intercepted\nFiles: virtual"
      ,
      children: [
        {
          id: "executor",
          title: "Wire the mock executor",
          kind: "subtask",
          owner: "builder",
          tool: "mcp.agent.spawn",
          description: "Sequence each task through several statuses without touching the server.",
          filePath: "mock/runtime/executor.ts",
          fileContent: "export const mode = \"mock\";\nexport const executeMcp = false;\nexport const tickMs = 650;"
        },
        {
          id: "controls",
          title: "Build playback controls",
          kind: "subtask",
          owner: "ui-agent",
          tool: "mcp.ui.controls",
          description: "Expose play, pause, reset, and sub-agent spawning as reactive controls.",
          filePath: "mock/ui/controls.tsx",
          fileContent: "export const controls = [\"play\", \"pause\", \"reset\", \"spawn\"];"
          ,
          children: [
            {
              id: "timeline",
              title: "Render task timeline + file feed",
              kind: "subtask",
              owner: "ui-agent",
              tool: "mcp.ui.render",
              description: "Keep the plan tree, event stream, and virtual file view in sync.",
              filePath: "mock/ui/timeline.tsx",
              fileContent: "// each event is append-only; each file has a virtual version",
              challenge: {
                title: "Timeline falls behind a spawned agent",
                symptom: "A new child event arrives while the selected task is still rendering.",
                solution: "Escalate to blocker because the visible state can become misleading during hand-off.",
                outcome: "blocker",
                workaround: "Append events by id and derive visible task state from the latest event, never from the selected row."
              }
            }
          ]
        }
      ]
    },
    {
      id: "verify",
      title: "Verify the dry-run contract",
      kind: "task",
      owner: "reviewer",
      tool: "mcp.assert",
      description: "Check that the complete flow is observable and that no real MCP call can escape.",
      filePath: "mock-plan/verification.md",
      fileContent: "# Verification\n\n- no network\n- no server writes\n- nested task coverage\n- challenge recovery"
    }
  ]
};

export const PLAYBACK_PHASES: Array<{ status: TaskStatus; label: string; detail: string; progress: number }> = [
  { status: "queued", label: "Queued", detail: "accepted by mock queue", progress: 12 },
  { status: "running", label: "Planning", detail: "building task context", progress: 32 },
  { status: "running", label: "Calling mock tool", detail: "intercepted · no MCP side effect", progress: 52 },
  { status: "writing", label: "Updating file", detail: "writing to virtual workspace", progress: 76 },
  { status: "waiting", label: "Handing off", detail: "waiting for child/parent acknowledgement", progress: 90 },
  { status: "completed", label: "Completed", detail: "result returned to parent task", progress: 100 }
];
