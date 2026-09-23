import { AUTO_MODEL_ORDER } from "../modelCatalog";
import { createInterface } from "node:readline";
import { createTurnGrillHistoryReader } from "./turnGrillContext";
import {
  SessionStore,
  type SessionInspectInput,
  type SessionSearchInput,
  type SessionVectorSearchInput
} from "./sessionStore";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type SessionQuestionInput = {
  sessionId?: string;
  threadId?: string;
  workspaceId?: string;
  question: string;
  q?: string;
  status?: "done" | "todo" | "running";
  turnLimit?: number;
  turnOffset?: number;
  maxTextChars?: number | null;
};

type SessionPromptInput = {
  sessionId?: string;
  threadId?: string;
  workspaceId?: string;
  message: string;
  model?: string;
  modelReasoningEffort?: string;
  approvalPolicy?: string;
  executionMode?: "default" | "plan" | "goal" | "loop";
  skills?: unknown[];
  forcePlan?: boolean;
  autoModel?: boolean;
  loadBalanceInWorkspace?: boolean;
  queueIfRunning?: boolean;
};

const apiBaseUrl = process.env.SESSION_INSPECTOR_SERVER_URL?.replace(/\/$/, "") || null;
const managerSessionId = process.env.THREADEX_SESSION_ID?.trim() || null;
const managerThreadId = process.env.THREADEX_THREAD_ID?.trim() || null;
const managerTurnId = process.env.THREADEX_TURN_ID?.trim() || null;
const autoModelEnabled = process.env.THREADEX_AUTO_MODEL === "1";
const managerModel = process.env.THREADEX_MODEL?.trim() || null;
const managerModelReasoningEffort = process.env.THREADEX_MODEL_REASONING_EFFORT?.trim() || null;
const managerApprovalPolicy = process.env.THREADEX_APPROVAL_POLICY?.trim() || null;
const managerChildExecutionMode = process.env.THREADEX_CHILD_EXECUTION_MODE?.trim() || null;
const managerChildSkills = parseManagerChildSkills(process.env.THREADEX_CHILD_SKILLS);
const managerContextForkRequest = process.env.THREADEX_CONTEXT_FORK_REQUEST === "1";
const continuityOnly = process.env.THREADEX_CONTINUITY_ONLY === "1";
const lightweightTodo = process.env.THREADEX_LIGHTWEIGHT_TODO === "1";
const todoAgentRole = process.env.THREADEX_TODO_AGENT_ROLE?.trim() || "default";
const grillTurnId = process.env.THREADEX_GRILL_TURN_ID?.trim() || null;
const grillHistoryRequest = todoAgentRole === "turn_grill" && managerSessionId
  && grillTurnId ? createTurnGrillHistoryReader(managerSessionId, grillTurnId) : null;
const todoInitialGrillRequired = process.env.THREADEX_TODO_REQUIRE_INITIAL_GRILL === "1";
const todoParentSessionId = process.env.THREADEX_TODO_PARENT_SESSION_ID?.trim() || null;
const todoItemId = process.env.THREADEX_TODO_ITEM_ID?.trim() || null;
let store: SessionStore | null = null;

const todoPlanItemSchema: Record<string, unknown> = {
  type: "object",
  required: ["title"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Optional unique input label only. The server assigns the persistent todo item ID."
    },
    title: { type: "string", minLength: 1, maxLength: 500 },
    details: { type: "string", maxLength: 12000 },
    context: { type: "string", maxLength: 50000 },
    status: { type: "string", enum: ["todo", "active", "paused", "hold", "skipped", "done", "blocked"] },
    activeStatus: { type: "string", maxLength: 1000 },
    children: {
      type: "array",
      maxItems: 200,
      description: "Nested todo items. Every entry must be a complete object, never a string ID.",
      items: { $ref: "#/$defs/todoPlanItem" }
    }
  },
  additionalProperties: false
};

const tools: ToolSpec[] = [
  {
    name: "recover_current_session",
    description:
      "Recover saved turns from the current Threadex session when Codex compaction or an incomplete summary may have omitted an earlier correction, decision, final result, or implementation detail. Defaults to the 20 newest completed turns and requires no session id.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Optional case-insensitive phrase filter over saved user prompts and final assistant responses. Omit to recover recent completed turns."
        },
        turnLimit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        turnOffset: { type: "integer", minimum: 0, default: 0 },
        maxTextChars: {
          type: "integer",
          minimum: 200,
          maximum: 50000,
          default: 20000,
          description: "Maximum characters returned for each saved user prompt and final assistant response."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_session",
    description:
      "Inspect a stored Codex session by local sessionId or Codex threadId. Supports turn/event pagination, text filtering, status filters, and optional live tool items.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Threadex tx_ session id. Legacy local_ aliases and unprefixed imported IDs are also accepted." },
        threadId: { type: "string", description: "Codex thread id associated with the session." },
        workspaceId: { type: "string", description: "Workspace id used to resolve a session across workspaces." },
        view: {
          type: "string",
          enum: ["full", "file_changes", "turn_summary"],
          default: "full",
          description:
            "full returns the existing detailed session payload. file_changes returns only changed files and +/- line counts. turn_summary returns each turn's user prompt, final assistant text/conclusion, and file changes."
        },
        turnId: { type: "string" },
        status: { type: "string", enum: ["done", "todo", "running"] },
        q: { type: "string", description: "Case-insensitive filter over user_input and agent_response." },
        includeEvents: { type: "boolean", default: false },
        includeLiveItems: { type: "boolean", default: false },
        includeSideChats: { type: "boolean", default: false },
        eventName: { type: "string" },
        turnLimit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        turnOffset: { type: "integer", minimum: 0, default: 0 },
        eventLimit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        eventOffset: { type: "integer", minimum: 0, default: 0 },
        sideChatLimit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        sideChatOffset: { type: "integer", minimum: 0, default: 0 },
        order: { type: "string", enum: ["asc", "desc"], default: "asc" },
        maxTextChars: { type: "integer", minimum: 200, maximum: 250000, default: 20000 }
      },
      anyOf: [{ required: ["sessionId"] }, { required: ["threadId"] }],
      additionalProperties: false
    }
  },
  {
    name: "search_sessions",
    description:
      "Globally search stored Codex session turns with case-insensitive contains search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text. Omit to page through recent turns." },
        workspaceId: { type: "string" },
        sessionId: { type: "string" },
        threadId: { type: "string" },
        status: { type: "string", enum: ["done", "todo", "running"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxTextChars: { type: "integer", minimum: 200, maximum: 250000, default: 20000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "ask_session",
    description:
      "Answer a question from one saved Codex session using the server's luna model. Read-only side chat: it uses a forked ephemeral agent context and does not create session turns, run commands, or edit files.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        sessionId: { type: "string" },
        threadId: { type: "string" },
        workspaceId: { type: "string", description: "Workspace id used to resolve a session across workspaces." },
        question: { type: "string" },
        q: { type: "string", description: "Optional case-insensitive turn filter used to select context." },
        status: { type: "string", enum: ["done", "todo", "running"] },
        turnLimit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        turnOffset: { type: "integer", minimum: 0, default: 0 },
        maxTextChars: { type: "integer", minimum: 200, maximum: 250000, default: 12000 }
      },
      anyOf: [{ required: ["sessionId"] }, { required: ["threadId"] }],
      additionalProperties: false
    }
  },
  {
    name: "prompt_session",
    description:
      "Add a real prompt to a Threadex session. This starts or queues the normal runner and writes a normal session turn/log; use ask_session for read-only side chat.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        sessionId: { type: "string" },
        threadId: { type: "string" },
        workspaceId: { type: "string", description: "Workspace id used to resolve a session across workspaces." },
        message: { type: "string", minLength: 1, maxLength: 250000 },
        model: { type: "string" },
        modelReasoningEffort: { type: "string" },
        approvalPolicy: { type: "string", description: "Defaults to the calling parent runner's approval policy when omitted." },
        executionMode: { type: "string", enum: ["default", "plan", "goal", "loop"], default: "default" },
        skills: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "path"],
            properties: {
              name: { type: "string" },
              path: { type: "string" }
            },
            additionalProperties: false
          }
        },
        forcePlan: { type: "boolean", default: false },
        autoModel: { type: "boolean" },
        loadBalanceInWorkspace: { type: "boolean" },
        queueIfRunning: {
          type: "boolean",
          default: true,
          description: "When the target session already has a running turn, create a queued pending turn instead of starting a parallel runner."
        }
      },
      anyOf: [{ required: ["sessionId"] }, { required: ["threadId"] }],
      additionalProperties: false
    }
  },
  {
    name: "vector_status",
    description: "Report whether vector search prerequisites are available for stored session descriptions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "vector_search",
    description:
      "Search session_description_embedding with a caller-supplied embedding vector. Only session descriptions are embedded; this tool does not generate embeddings.",
    inputSchema: {
      type: "object",
      required: ["embedding"],
      properties: {
        embedding: { type: "array", items: { type: "number" }, minItems: 1 },
        workspaceId: { type: "string" },
        sessionId: { type: "string" },
        threadId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxTextChars: { type: "integer", minimum: 200, maximum: 250000, default: 20000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_processes",
    description: "List compact status for processes currently monitored by Threadex in the active workspace, including built-in read-only health records for the externally managed API server and Vite client.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "list_wait_events",
    description: "List durable backend wait events and their per-session subscriptions in the active workspace. Use this to inspect what sessions are waiting for and whether delivery succeeded.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "subscribe_wait_event",
    description: "Subscribe a session to an existing durable wait event. A fired retained event dispatches the subscription immediately. Use enqueue_prompt with actionPayload.message for follow-ups, retry_turn with turnId for pending turns, or notify for state-only observation. Enqueued prompts inherit the calling runner's approval policy unless actionPayload.approvalPolicy is provided.",
    inputSchema: {
      type: "object",
      required: ["eventId", "sessionId", "actionType"],
      properties: {
        eventId: { type: "string" },
        sessionId: { type: "string" },
        turnId: { type: "string" },
        actionType: { type: "string", enum: ["retry_turn", "enqueue_prompt", "notify"] },
        actionPayload: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "monitor_process",
    description: "Start a restartable process from a complete launch spec, temporarily observe one existing PID, or attach an existing PID with a complete launch spec for later restart. All monitors default to automatic cleanup after completion; set removeOnExit: false explicitly to retain one after exit. Labels are display text only and never discover a process. PID-only monitors store no executable/args, cannot restart, and disappear when that PID exits by default. A PID paired with exe plus complete args, dockerImage, or command keeps that launch spec: it can be restarted into a Threadex-owned, captured process. Threadex captures logs only for commands it launches; external attachments and supervisor-managed processes may have no readable output. Add metrics when output may be unavailable: each name-and-command probe reports its latest value in the monitor detail panel. Never launch a bare interpreter such as node, sh, bash, or python. Do not create duplicate built-in monitors. When list_processes marks a built-in read-only record restartable, restart_process_monitor delegates to its external supervisor.",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 100 },
        pid: { type: "integer", minimum: 1, description: "Existing process to attach. Alone, creates a temporary monitor that disappears on exit. Pair with one complete launch spec to retain Restart control; the current PID is not restarted until restart_process_monitor is called." },
        exe: { type: "string", minLength: 1, maxLength: 1000, description: "Executable to launch for a durable monitor. Interpreters require args containing a script or command; bare node/sh/bash/python is rejected." },
        args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4000 }, description: "Complete argument vector passed to exe, or container-command args after dockerImage. Include script paths and flags; for shells normally use [\"-c\", \"command...\"]." },
        command: { type: "string", minLength: 1, maxLength: 4000, description: "Legacy shell command; prefer exe, dockerImage, or dockerImage + args." },
        dockerImage: { type: "string", maxLength: 500, description: "Docker image to run with docker run --rm." },
        image: { type: "string", maxLength: 500, description: "Alias for dockerImage." },
        dockerRunArgs: {
          type: "array",
          maxItems: 64,
          items: { type: "string", maxLength: 4000 },
          description: "Optional arguments passed to docker run before the image, such as -p 8080:80."
        },
        logFile: { type: "string", maxLength: 2000, description: "Optional output file path inside the active workspace. Combined stdout/stderr is captured here and remains available in the log popup across restarts." },
        metrics: {
          type: "array",
          maxItems: 8,
          description: "Optional progress probes. Each runs periodically and shows its latest stdout value in the detail panel; use when external process logs cannot be captured.",
          items: {
            type: "object",
            required: ["name", "command"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100 },
              command: { type: "string", minLength: 1, maxLength: 4000 },
              nameSuffix: { type: "boolean", description: "Append this metric's latest successful value to the process-monitor name in the sidebar." }
            },
            additionalProperties: false
          }
        },
        entryPoints: {
          type: "array",
          maxItems: 16,
          items: { type: "string", format: "uri", maxLength: 2000 },
          description: "Optional HTTP(S) URLs for opening the monitored process in the web UI."
        },
        cwd: { type: "string", description: "Optional path inside the active workspace." },
        wakePrompt: { type: "string", maxLength: 12000, description: "Optional follow-up prompt queued when the process exits, using the calling runner's approval policy." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 604800, description: "Maximum monitor lifetime in seconds." },
        removeOnExit: { type: "boolean", default: true, description: "Automatically remove the monitor after completion. Explicitly set false only for a persistent monitor that must remain available after exit." }
      },
      additionalProperties: false
    }
  },
  {
    name: "adopt_process_monitor",
    description: "Attach a complete durable restart launch spec to an already-running PID without restarting it. Use this to convert a temporary PID monitor. The attached process remains external and is only signalled by its exact PID; after its first restart, the new process is launched and captured by Threadex. External process logs may be unavailable; optional metrics provide independently sampled progress values. Requires the monitor id, live pid, and exactly one of exe plus complete args, dockerImage, or command.",
    inputSchema: {
      type: "object",
      required: ["id", "pid"],
      properties: {
        removeOnExit: { type: "boolean", description: "Preserves the existing cleanup setting when omitted. Set false explicitly to retain the monitor after exit." },
        id: { type: "string" },
        pid: { type: "integer", minimum: 1 },
        label: { type: "string", minLength: 1, maxLength: 100 },
        exe: { type: "string", minLength: 1, maxLength: 1000 },
        args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4000 } },
        command: { type: "string", minLength: 1, maxLength: 4000 },
        dockerImage: { type: "string", maxLength: 500 },
        image: { type: "string", maxLength: 500 },
        dockerRunArgs: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4000 } },
        logFile: { type: "string", maxLength: 2000, description: "Optional output file path inside the active workspace; preserved when this monitor is restarted or its launch command is changed." },
        metrics: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            required: ["name", "command"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100 },
              command: { type: "string", minLength: 1, maxLength: 4000 },
              nameSuffix: { type: "boolean", description: "Append this metric's latest successful value to the process-monitor name in the sidebar." }
            },
            additionalProperties: false
          }
        },
        entryPoints: { type: "array", maxItems: 16, items: { type: "string", format: "uri", maxLength: 2000 } },
        cwd: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "restart_process_monitor",
    description: "Restart a monitor with a complete launch spec by id. For an externally attached PID, first stop that PID only, then launch the saved spec.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "stop_process_monitor",
    description: "Stop a live monitored PID while retaining the monitor and any restart launch spec. External attachments are signalled by exact PID only.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "remove_process_monitor",
    description: "Remove a process monitor; any live monitored PID is stopped first. External attachments are signalled by exact PID only.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    }
  }
];

if (managerSessionId) {
  tools.push(
    {
      name: "todo_list",
      description: "Read the current session's detailed todo snapshot, including flat items, itemTree, todo/item context, item status/progress messages, comments, pause control state, and child sessions under items.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional parent session id. Defaults to the current Threadex session." }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_get_detail",
      description: "Read full todo detail for a session: items, context, item tree, status/progress messages, and one-or-more child sessions under each item.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional parent session id. Defaults to the current Threadex session." }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_add_item",
      description: "Add one todo item. Use parentId to create nested subtasks. Status may be todo, active, paused, hold, skipped, done, or blocked.",
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          sessionId: { type: "string" },
          parentId: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          details: { type: "string", maxLength: 12000 },
          context: { type: "string", maxLength: 50000, description: "Durable context for this item. Prepare this before work starts and update it when the worker learns reusable context." },
          section: { type: "string", enum: ["solution", "verification"], description: "Plan section. Nested items should normally inherit their parent's section." },
          status: { type: "string", enum: ["todo", "active", "paused", "hold", "skipped", "done", "blocked"] },
          position: { type: "number" },
          activeStatus: { type: "string", maxLength: 1000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_set_plan",
      description: "Set the complete initial plan as Problem + Objective, followed by Solution + Verification todo items. If Problem or Objective is unclear, ask focused grill-me questions instead of calling this tool. Use full item objects at every level. Never put string IDs in children or use parentId. Persistent IDs are assigned by the server. This may only be used while the session has no todo items.",
      inputSchema: {
        type: "object",
        required: ["problem", "objective", "solution", "verification"],
        properties: {
          sessionId: { type: "string" },
          problem: { type: "string", minLength: 1, maxLength: 12000, description: "Factual motivating limitation, failure mode, or unmet need. Do not describe the implementation." },
          objective: { type: "string", minLength: 1, maxLength: 12000, description: "Observable desired outcome. Do not prescribe the implementation." },
          solution: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: { $ref: "#/$defs/todoPlanItem" }
          },
          verification: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: { $ref: "#/$defs/todoPlanItem" }
          }
        },
        $defs: { todoPlanItem: todoPlanItemSchema },
        additionalProperties: false
      }
    },
    {
      name: "todo_request_clarification",
      description: "Record focused grill-me questions when a factual Problem or observable Objective cannot yet be established. Use this instead of guessing or calling todo_set_plan. No todo items are created.",
      inputSchema: {
        type: "object",
        required: ["questions"],
        properties: {
          sessionId: { type: "string" },
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string", minLength: 1, maxLength: 2000 }
          },
          problem: { type: "string", maxLength: 12000, description: "Known factual part of the Problem, if any." },
          objective: { type: "string", maxLength: 12000, description: "Known observable part of the Objective, if any." }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_update_item",
      description: "Update a single todo item status/content/parent/order. Set activeStatus to a short one- or two-sentence execution status while working.",
      inputSchema: {
        type: "object",
        required: ["itemId"],
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string" },
          parentId: { type: "string" },
          title: { type: "string", maxLength: 500 },
          details: { type: "string", maxLength: 12000 },
          context: { type: "string", maxLength: 50000 },
          section: { type: "string", enum: ["solution", "verification"] },
          status: { type: "string", enum: ["todo", "active", "paused", "hold", "skipped", "done", "blocked"] },
          position: { type: "number" },
          activeStatus: { type: "string", maxLength: 1000 },
          lockReason: { type: "string", maxLength: 1000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_set_context",
      description: "Update durable context for the whole todo plan or one todo item. Use this when prepared context changes or a worker learns reusable context.",
      inputSchema: {
        type: "object",
        required: ["context"],
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string", description: "Omit to update whole-plan context." },
          context: { type: "string", maxLength: 50000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_add_comment",
      description: "Add a status, blocker, or note comment to the todo plan or one item. Use blocker for difficulties that need user attention.",
      inputSchema: {
        type: "object",
        required: ["body"],
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string" },
          type: { type: "string", enum: ["status", "blocker", "note"] },
          body: { type: "string", minLength: 1, maxLength: 12000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_add_message",
      description: "Add a short item-level status/progress message. In Todo MCP mode, call this whenever you send a user-facing commentary/status comment about plan execution, using the comment's short headline as the title. type defaults to update. Use challenge when work is not going smoothly; the result includes an incremental challengeId that must later be resolved.",
      inputSchema: {
        type: "object",
        required: ["itemId", "title"],
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string" },
          type: { type: "string", enum: ["update", "challenge"], default: "update" },
          title: { type: "string", minLength: 1, maxLength: 300, description: "Short one-sentence, title-like status." },
          body: { type: "string", maxLength: 12000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_resolve_challenge",
      description: "Resolve an unresolved todo challenge by its incremental challengeId after explaining or fixing the issue.",
      inputSchema: {
        type: "object",
        required: ["challengeId"],
        properties: {
          sessionId: { type: "string" },
          challengeId: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_set_control",
      description: "Pause or resume the whole todo plan for the current session. Initial todo plans should normally be paused after publication so the user can review or edit before execution.",
      inputSchema: {
        type: "object",
        required: ["paused"],
        properties: {
          sessionId: { type: "string" },
          paused: { type: "boolean" },
          pauseReason: { type: "string", maxLength: 1000 },
          context: { type: "string", maxLength: 50000 }
        },
        additionalProperties: false
      }
    },
    {
      name: "todo_create_task",
      description: "Create the first background child Codex task for an unassigned todo item and link it into the shared todo plan. This tool is unavailable inside worker tasks: follow-ups must continue in the current worker task. By default this only creates the queued child session; set startImmediately=true only when the user explicitly asked to execute now or the plan has been reviewed/resumed.",
      inputSchema: {
        type: "object",
        required: ["itemId", "prompt"],
        properties: {
          sessionId: { type: "string" },
          itemId: { type: "string" },
          prompt: { type: "string", minLength: 1, maxLength: 250000 },
          title: { type: "string", minLength: 1, maxLength: 160 },
          startImmediately: { type: "boolean", default: false }
        },
        additionalProperties: false
      }
    }
  );

  tools.push({
    name: "create_task",
    description:
      "Create a new background Codex task whose parent is the current Threadex session. By default this only creates the child session; set startImmediately=true to run it now. The prompt must be a self-contained handoff assembled from the current thread context.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 250000,
          description: "Self-contained task prompt including all relevant context, constraints, current state, and verification expectations."
        },
        title: { type: "string", minLength: 1, maxLength: 160 },
        startImmediately: { type: "boolean", default: false },
        model: { type: "string", description: "Optional model for the child task. Defaults to the current task model." },
        modelReasoningEffort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort for the child task. Defaults to the current task effort."
        }
      },
      additionalProperties: false
    }
  });
}

if (autoModelEnabled) {
  tools.push({
    name: "upgrade_model",
    description:
      "Upgrade this Auto session to a stronger model and/or reasoning effort. Jumps are allowed. Downgrades within a turn are rejected. Call only immediately before substantive technical or business judgment requires a stronger setting.",
    inputSchema: {
      type: "object",
      required: ["model", "effort", "reason"],
      properties: {
        model: { type: "string", enum: [...AUTO_MODEL_ORDER] },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        reason: {
          type: "string",
          minLength: 10,
          maxLength: 500,
          description: "The specific upcoming technical or business decision that needs the stronger setting."
        }
      },
      additionalProperties: false
    }
  });
}

const outcomeItemSchema = {
  type: "object", required: ["title", "acceptance"], additionalProperties: false,
  properties: {
    id: { type: "string", description: "Existing persistent ID; omit for a new outcome." },
    title: { type: "string", minLength: 1, maxLength: 500 },
    acceptance: { type: "string", minLength: 1, maxLength: 2000 },
    children: { type: "array", items: { $ref: "#/$defs/item" } }
  }
};
if (lightweightTodo && managerSessionId && apiBaseUrl) {
  tools.push(
    { name: "outcome_plan_get", description: "Read this session's lightweight outcome plan, revision and summariser-owned status.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "outcome_plan_set", description: "Create or revise the complete nested content-focused outcome plan. Agent owns content only; summariser owns status. Preserve existing IDs, omit IDs for new items, omission deletes items. Read current revision first. Does not pause execution.", inputSchema: {
      type: "object", required: ["baseRevision", "objective", "items"], additionalProperties: false,
      properties: { baseRevision: { type: "integer", minimum: 0 }, objective: { type: "string", minLength: 1, maxLength: 2000 }, items: { type: "array", maxItems: 100, items: { $ref: "#/$defs/item" } } },
      $defs: { item: outcomeItemSchema }
    } }
  );
}

const commandLaunchProperties = { ...(tools.find((tool) => tool.name === "monitor_process")!.inputSchema.properties as Record<string, unknown>) };
for (const key of ["pid", "wakePrompt", "timeoutSeconds"]) delete commandLaunchProperties[key];
commandLaunchProperties.parameters = {
  type: "array", maxItems: 32,
  description: 'User-editable launch parameters. Use {{name}} in args/dockerRunArgs; in shell command text use quoted "$THREADEX_PARAM_name". Each run receives THREADEX_PARAM_name environment variables.',
  items: {
    type: "object", required: ["name", "desc", "type", "default"], additionalProperties: false,
    properties: {
      name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
      desc: { type: "string", maxLength: 2000 },
      type: { type: "string", enum: ["option", "string", "number"] },
      default: { type: ["string", "number"] },
      options: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1 }, description: "Required for option parameters; default must be one of these values." }
    }
  }
};
tools.push({
  name: "register_process_command",
  description: "Save a reusable command in the workspace Available tab without executing it. Supply exactly one complete launch spec: exe with args, command, or dockerImage. Returns an id for run_process_command; users can also click Run. Each run creates a separate captured process monitor and keeps the command available.",
  inputSchema: { type: "object", required: ["label"], properties: commandLaunchProperties, additionalProperties: false }
}, {
  name: "run_process_command",
  description: "Execute an available registered command by id and create a Running process monitor with captured logs. Use list_processes to discover commands with status available. The saved command remains available for later runs.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, parameterValues: { type: "object", additionalProperties: { type: ["string", "number"] }, description: "Values keyed by registered parameter name. Omitted values use their defaults." } }, additionalProperties: false }
});

function toolsForAgent() {
  if (todoAgentRole === "turn_grill") return tools.filter((tool) => tool.name === "get_session");
  if (lightweightTodo) return tools.filter((tool) => !tool.name.startsWith("todo_"));
  if (continuityOnly) {
    return tools.filter((tool) =>
      tool.name === "recover_current_session" ||
      tool.name === "get_session" ||
      tool.name === "search_sessions"
    );
  }
  if (todoAgentRole === "side_chat") {
    return tools.filter((tool) => tool.name === "get_session" || tool.name === "search_sessions");
  }
  if (todoAgentRole === "planner") {
    return tools.filter((tool) =>
      tool.name === "todo_set_plan" ||
      tool.name === "todo_request_clarification" ||
      (managerContextForkRequest && tool.name === "create_task")
    );
  }
  if (todoAgentRole === "worker") {
    return tools.filter((tool) =>
      tool.name !== "todo_set_plan" &&
      tool.name !== "todo_request_clarification" &&
      tool.name !== "todo_create_task" &&
      (tool.name !== "create_task" || managerContextForkRequest)
    );
  }
  return tools;
}

function isToolExposed(name: string) {
  return toolsForAgent().some((tool) => tool.name === name);
}

const rl = createInterface({ input: process.stdin });
let messageQueue = Promise.resolve();

rl.on("line", (line) => {
  messageQueue = messageQueue
    .then(() => handleLine(line))
    .catch((error) => {
      process.stderr.write(`session-inspector MCP error: ${errorMessage(error)}\n`);
    });
});

process.once("SIGINT", () => {
  void closeAndExit(130);
});
process.once("SIGTERM", () => {
  void closeAndExit(143);
});

async function handleLine(line: string) {
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    writeResponse(null, null, { code: -32700, message: "Parse error" });
    return;
  }

  if (message.id === undefined || message.id === null) {
    return;
  }

  try {
    if (message.method === "initialize") {
      writeResponse(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "session-inspector", version: "0.1.0" }
      });
      return;
    }

    if (message.method === "tools/list") {
      writeResponse(message.id, { tools: toolsForAgent() });
      return;
    }

    if (message.method === "tools/call") {
      writeResponse(message.id, await callTool(message.params));
      return;
    }

    if (message.method === "shutdown") {
      writeResponse(message.id, {});
      await closeAndExit(0);
      return;
    }

    writeResponse(message.id, null, { code: -32601, message: `Method not found: ${message.method ?? ""}` });
  } catch (error) {
    writeResponse(message.id, toolError(error));
  }
}

async function callTool(params: unknown) {
  const record = readObject(params);
  const name = readString(record?.name);
  const args = readObject(record?.arguments) ?? {};

  if (!name || !isToolExposed(name)) {
    throw new Error(`Tool is not available to this ${todoAgentRole} agent: ${name ?? "unknown"}`);
  }

  if (name === "outcome_plan_get" || name === "outcome_plan_set") {
    const path = `/api/sessions/${encodeURIComponent(managerSessionId!)}/outcome-plan`;
    return toolResult(name === "outcome_plan_get" ? await getJson(path) : await postJson(path, args));
  }

  if (name === "get_session") {
    if (todoAgentRole === "turn_grill") {
      if (!grillHistoryRequest) throw new Error("Grill me target session is unavailable.");
      const result = readObject(await inspectSession(grillHistoryRequest(args)));
      if (!result) return toolResult(null);
      const session = readObject(result.session);
      const turns = Array.isArray(result.turns) ? result.turns.map(readObject).filter((turn) => turn !== null) : [];
      return toolResult({
        session: { id: session?.id, title: session?.title },
        turns: turns.map((turn) => ({
          id: turn.id, userInput: turn.userInput, agentResponse: turn.agentResponse,
          userInputOmittedChars: turn.userInputOmittedChars,
          agentResponseOmittedChars: turn.agentResponseOmittedChars,
          ...(Array.isArray(turn.liveItems) ? { liveItems: turn.liveItems } : {})
        })),
        turnPage: result.turnPage,
        contextNote: "Bounded saved history, possibly truncated. Later turns may contain corrections; do not treat them as evidence available during the selected turn."
      });
    }
    return toolResult(await inspectSession(args as SessionInspectInput));
  }

  if (name === "recover_current_session") {
    if (!managerSessionId) {
      throw new Error("Current Threadex session id is unavailable.");
    }
    return toolResult(await inspectSession({
      sessionId: managerSessionId,
      view: "turn_summary",
      status: "done",
      order: "desc",
      q: readString(args.q) ?? undefined,
      turnLimit: readBoundedInteger(args.turnLimit, 20, 1, 100),
      turnOffset: readBoundedInteger(args.turnOffset, 0, 0, Number.MAX_SAFE_INTEGER),
      maxTextChars: readBoundedInteger(args.maxTextChars, 20_000, 200, 50_000)
    }));
  }

  if (name === "search_sessions") {
    return toolResult(await searchSessions(args as SessionSearchInput));
  }

  if (name === "ask_session") {
    return toolResult(await askSession(args as SessionQuestionInput));
  }

  if (name === "prompt_session") {
    return toolResult(await promptSession(args as SessionPromptInput));
  }

  if (name === "vector_status") {
    return toolResult(await vectorStatus());
  }

  if (name === "vector_search") {
    return toolResult(await vectorSearch(args as SessionVectorSearchInput));
  }

  if (name === "list_processes") {
    return toolResult(await listProcesses());
  }

  if (name === "list_wait_events") {
    return toolResult(await getJson("/api/wait-events"));
  }

  if (name === "subscribe_wait_event") {
    const actionPayload = readObject(args.actionPayload);
    const inheritedApprovalPolicy = readString(actionPayload?.approvalPolicy) ?? managerApprovalPolicy;
    return toolResult(await postJson("/api/wait-subscriptions", {
      ...args,
      ...(readString(args.actionType) === "enqueue_prompt" && actionPayload
        ? {
            actionPayload: {
              ...actionPayload,
              ...(inheritedApprovalPolicy ? { approvalPolicy: inheritedApprovalPolicy } : {})
            }
          }
        : {})
    }));
  }

  if (name === "todo_list" || name === "todo_get_detail") {
    return toolResult(await getJson(`/api/sessions/${encodeURIComponent(readSessionIdArg(args))}/todos`));
  }

  if (name === "todo_add_item") {
    const sessionId = readSessionIdArg(args);
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/items`, {
      id: readString(args.id) ?? undefined,
      parentId: readString(args.parentId) ?? null,
      title: readRequiredString(args, "title"),
      details: readString(args.details) ?? "",
      context: readString(args.context) ?? "",
      section: readTodoPlanSection(args.section) ?? undefined,
      status: readString(args.status) ?? "todo",
      position: typeof args.position === "number" ? args.position : undefined,
      actor: "agent",
      turnId: managerTurnId,
      activeStatus: readString(args.activeStatus) ?? null
    }));
  }

  if (name === "todo_set_plan") {
    if (todoAgentRole === "planner" && todoInitialGrillRequired) {
      throw new Error("The Todo MCP toggle requires an initial grill-me round before plan creation. Call todo_request_clarification first and wait for the user's answers.");
    }
    const sessionId = readSessionIdArg(args);
    const problem = validateTodoPlanString(args.problem, "problem", 12000, false);
    const objective = validateTodoPlanString(args.objective, "objective", 12000, false);
    const solution = validateTodoPlanItems(args.solution, "solution");
    const verification = validateTodoPlanItems(args.verification, "verification");
    if (countTodoPlanItems(solution) + countTodoPlanItems(verification) > 200) {
      throw invalidTodoPlan("solution and verification may contain at most 200 items in total, including nested children.");
    }
    const current = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos`) as Record<string, unknown>;
    if (readArray(current.items).length > 0) {
      throw new Error("Todo plan already exists for this session. Use todo_update_item or todo_add_item instead of todo_set_plan.");
    }
    await createTodoItemsRecursive(sessionId, null, solution, "solution");
    await createTodoItemsRecursive(sessionId, null, verification, "verification");
    await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
      paused: true,
      pauseReason: "Initial Todo MCP plan created for review. Execution has not started.",
      problem,
      objective,
      context: "",
      actor: "agent"
    });
    return toolResult(await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos`));
  }

  if (name === "todo_request_clarification") {
    const sessionId = readSessionIdArg(args);
    const questions = readArray(args.questions).map((question, index) => (
      validateTodoPlanString(question, `questions[${index}]`, 2000, false)
    ));
    if (questions.length < 1 || questions.length > 5) {
      throw new Error("todo_request_clarification questions must contain between 1 and 5 focused questions.");
    }
    const problem = validateOptionalTodoPlanString(args.problem, "problem", 12000, "");
    const objective = validateOptionalTodoPlanString(args.objective, "objective", 12000, "");
    const current = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos`) as Record<string, unknown>;
    if (readArray(current.items).length > 0) {
      throw new Error("Todo plan already exists for this session; clarify through the existing plan instead.");
    }
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
      paused: true,
      pauseReason: "Todo MCP plan needs clarification before it can be created.",
      problem,
      objective,
      context: JSON.stringify({ clarificationQuestions: questions }),
      actor: "agent"
    }));
  }

  if (name === "todo_update_item") {
    const sessionId = readSessionIdArg(args);
    const itemId = readRequiredString(args, "itemId");
    return toolResult(await patchJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/items/${encodeURIComponent(itemId)}`, {
      parentId: readString(args.parentId) ?? undefined,
      title: readString(args.title) ?? undefined,
      details: readString(args.details) ?? undefined,
      context: readString(args.context) ?? undefined,
      section: readTodoPlanSection(args.section) ?? undefined,
      status: readString(args.status) ?? undefined,
      position: typeof args.position === "number" ? args.position : undefined,
      actor: "agent",
      turnId: managerTurnId,
      activeStatus: readString(args.activeStatus) ?? undefined,
      lockReason: readString(args.lockReason) ?? undefined
    }));
  }

  if (name === "todo_set_context") {
    const sessionId = readSessionIdArg(args);
    const context = readRequiredString(args, "context");
    const itemId = readString(args.itemId);
    if (itemId) {
      return toolResult(await patchJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/items/${encodeURIComponent(itemId)}`, {
        context,
        actor: "agent",
        turnId: managerTurnId
      }));
    }
    const todo = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos`) as Record<string, unknown>;
    const control = readObject(todo.control) ?? {};
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
      paused: control.paused === true,
      pauseReason: readString(control.pauseReason) ?? null,
      context,
      actor: "agent"
    }));
  }

  if (name === "todo_add_comment") {
    const sessionId = readSessionIdArg(args);
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/comments`, {
      itemId: readString(args.itemId) ?? null,
      turnId: managerTurnId,
      type: readString(args.type) ?? "note",
      author: "agent",
      body: readRequiredString(args, "body")
    }));
  }

  if (name === "todo_add_message") {
    const sessionId = readSessionIdArg(args);
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/messages`, {
      itemId: readRequiredString(args, "itemId"),
      turnId: managerTurnId,
      type: readString(args.type) ?? "update",
      author: "agent",
      title: readRequiredString(args, "title"),
      body: readString(args.body) ?? ""
    }));
  }

  if (name === "todo_resolve_challenge") {
    const sessionId = readSessionIdArg(args);
    const challengeId = readNumber(args.challengeId);
    if (!Number.isSafeInteger(challengeId) || challengeId <= 0) {
      throw new Error("challengeId must be a positive integer.");
    }
    return toolResult(await postJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/todos/challenges/${encodeURIComponent(String(challengeId))}/resolve`,
      { actor: "agent" }
    ));
  }

  if (name === "todo_set_control") {
    const sessionId = readSessionIdArg(args);
    return toolResult(await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/control`, {
      paused: args.paused === true,
      pauseReason: readString(args.pauseReason) ?? null,
      context: readString(args.context) ?? undefined,
      actor: "agent"
    }));
  }

  if (name === "todo_create_task") {
    const sessionId = readSessionIdArg(args);
    const startImmediately = readBoolean(args.startImmediately) === true;
    return toolResult(await postJson("/api/session-tasks", {
      parentSessionId: sessionId,
      ...(managerSessionId ? { sourceSessionId: managerSessionId } : {}),
      todoItemId: readRequiredString(args, "itemId"),
      prompt: readRequiredString(args, "prompt"),
      ...(readString(args.title) ? { title: readString(args.title) } : {}),
      ...(startImmediately ? { startImmediately } : {}),
      ...(managerModel ? { model: managerModel } : {}),
      ...(managerModelReasoningEffort ? { modelReasoningEffort: managerModelReasoningEffort } : {}),
      ...(managerApprovalPolicy ? { approvalPolicy: managerApprovalPolicy } : {}),
      ...(managerChildExecutionMode ? { executionMode: managerChildExecutionMode } : {}),
      ...(managerChildSkills.length > 0 ? { skills: managerChildSkills } : {})
    }));
  }

  if (name === "register_process_command") {
    return toolResult(await monitorProcess({ ...args, registerOnly: true }));
  }

  if (name === "run_process_command") {
    return toolResult(await postJson(`/api/process-monitors/${encodeURIComponent(readRequiredString(args, "id"))}/run`, { parameterValues: args.parameterValues ?? {} }));
  }

  if (name === "monitor_process") {
    return toolResult(await monitorProcess(args));
  }

  if (name === "adopt_process_monitor") {
    const id = readRequiredString(args, "id");
    return toolResult(await postJson(`/api/process-monitors/${encodeURIComponent(id)}/adopt`, {
      ...args,
      id: undefined,
      ...(managerApprovalPolicy ? { approvalPolicy: managerApprovalPolicy } : {})
    }));
  }

  if (name === "restart_process_monitor") {
    return toolResult(await postJson(
      `/api/process-monitors/${encodeURIComponent(readRequiredString(args, "id"))}/restart`,
      managerApprovalPolicy ? { approvalPolicy: managerApprovalPolicy } : {}
    ));
  }

  if (name === "stop_process_monitor") {
    return toolResult(await postJson(`/api/process-monitors/${encodeURIComponent(readRequiredString(args, "id"))}/stop`, {}));
  }

  if (name === "remove_process_monitor") {
    return toolResult(await deleteJson(`/api/process-monitors/${encodeURIComponent(readRequiredString(args, "id"))}`));
  }

  if (name === "create_task") {
    if (!managerSessionId) {
      throw new Error("create_task requires a current Threadex session.");
    }
    const startImmediately = managerContextForkRequest || readBoolean(args.startImmediately) === true;
    const childModel = readString(args.model) ?? managerModel;
    const childModelReasoningEffort = readString(args.modelReasoningEffort) ?? managerModelReasoningEffort;
    return toolResult(await postJson("/api/session-tasks", {
      parentSessionId: managerSessionId,
      sourceSessionId: managerSessionId,
      ...(managerContextForkRequest ? { contextFork: true } : {}),
      prompt: readRequiredString(args, "prompt"),
      ...(readString(args.title) ? { title: readString(args.title) } : {}),
      ...(startImmediately ? { startImmediately } : {}),
      ...(childModel ? { model: childModel } : {}),
      ...(childModelReasoningEffort ? { modelReasoningEffort: childModelReasoningEffort } : {}),
      ...(managerApprovalPolicy ? { approvalPolicy: managerApprovalPolicy } : {}),
      ...(managerChildExecutionMode ? { executionMode: managerChildExecutionMode } : {}),
      ...(managerChildSkills.length > 0 ? { skills: managerChildSkills } : {})
    }));
  }

  if (name === "upgrade_model") {
    if (!autoModelEnabled || !managerSessionId) {
      throw new Error("upgrade_model is available only in an Auto session.");
    }
    return toolResult(await postJson("/api/session-auto-model/upgrade", {
      sessionId: managerSessionId,
      model: readRequiredString(args, "model"),
      effort: readRequiredString(args, "effort"),
      reason: readRequiredString(args, "reason")
    }));
  }

  throw new Error(`Unknown tool: ${name ?? ""}`);
}

async function inspectSession(input: SessionInspectInput) {
  if (apiBaseUrl) {
    return postJson("/api/session-inspector/session", input);
  }
  return getStore().inspectSession(input);
}

async function searchSessions(input: SessionSearchInput) {
  if (apiBaseUrl) {
    return postJson("/api/session-inspector/search", input);
  }
  return getStore().searchSessions(input);
}

async function askSession(input: SessionQuestionInput) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is required for ask_session.");
  }
  return postJson("/api/session-inspector/ask", {
    ...input,
    ...(managerSessionId ? { sourceSessionId: managerSessionId } : {}),
    ...(managerThreadId ? { sourceThreadId: managerThreadId } : {}),
    ...(managerTurnId ? { sourceTurnId: managerTurnId } : {})
  });
}

async function promptSession(input: SessionPromptInput) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is required for prompt_session.");
  }

  const message = readRequiredString(input as unknown as Record<string, unknown>, "message");
  const inspected = await inspectSession({
    sessionId: input.sessionId,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    status: "running",
    turnLimit: 1,
    maxTextChars: 200
  });
  const inspection = readObject(inspected);
  const session = readObject(inspection?.session);
  const sessionId = readString(session?.id);
  if (!sessionId) {
    throw new Error("Target session not found.");
  }

  const runningTurns = readArray(inspection?.turns);
  const approvalPolicy = readString(input.approvalPolicy) ?? managerApprovalPolicy;
  const payload = {
    message,
    sessionId,
    workspaceId: readString(session?.workspaceId) ?? input.workspaceId,
    ...(readString(input.model) ? { model: readString(input.model) } : {}),
    ...(readString(input.modelReasoningEffort) ? { modelReasoningEffort: readString(input.modelReasoningEffort) } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(readString(input.executionMode) ? { executionMode: readString(input.executionMode) } : {}),
    ...(Array.isArray(input.skills) ? { skills: input.skills } : {}),
    ...(input.forcePlan !== undefined ? { forcePlan: input.forcePlan === true } : {}),
    ...(input.autoModel !== undefined ? { autoModel: input.autoModel === true } : {}),
    ...(input.loadBalanceInWorkspace !== undefined ? { loadBalanceInWorkspace: input.loadBalanceInWorkspace === true } : {})
  };

  if (runningTurns.length > 0 && input.queueIfRunning !== false) {
    const queued = await postJson("/api/pending-turns", payload);
    return {
      ok: true,
      mode: "queued",
      message: "Target session is running; prompt was queued as a normal pending turn.",
      ...readObject(queued)
    };
  }

  return postChatStream(payload);
}

async function vectorStatus() {
  if (apiBaseUrl) {
    return getJson("/api/session-inspector/vector/status");
  }
  return getStore().getSessionVectorStatus();
}

async function vectorSearch(input: SessionVectorSearchInput) {
  if (apiBaseUrl) {
    return postJson("/api/session-inspector/vector/search", input);
  }
  return getStore().searchSessionVectors(input);
}

async function listProcesses() {
  const result = await getJson("/api/process-monitors");
  const records = readArray(readObject(result)?.processMonitors);
  return {
    processes: records.map((record) => {
      const value = readObject(record) ?? {};
      return {
        id: readString(value.id),
        label: readString(value.label),
        status: readString(value.status),
        parameters: Array.isArray(value.parameters) ? value.parameters : [],
        readOnly: value.readOnly === true,
        restartable: value.restartable === true,
        pid: typeof value.pid === "number" ? value.pid : null,
        exe: readString(value.executable),
        dockerImage: readString(value.dockerImage),
        dockerRunArgs: Array.isArray(value.dockerRunArgs) ? value.dockerRunArgs : [],
        args: Array.isArray(value.args) ? value.args : [],
        logFile: readString(value.logFile),
        command: readString(value.command),
        entryPoints: Array.isArray(value.entryPoints) ? value.entryPoints.filter((item): item is string => typeof item === "string") : [],
        wakeStatus: readString(value.wakeStatus)
      };
    })
  };
}

async function monitorProcess(input: Record<string, unknown>) {
  return postJson("/api/process-monitors", {
    ...(input.registerOnly === true ? { registerOnly: true } : {}),
    ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
    label: readRequiredString(input, "label"),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.exe !== undefined ? { exe: input.exe } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.dockerImage !== undefined ? { dockerImage: input.dockerImage } : {}),
    ...(input.image !== undefined ? { image: input.image } : {}),
    ...(input.dockerRunArgs !== undefined ? { dockerRunArgs: input.dockerRunArgs } : {}),
    ...(input.logFile !== undefined ? { logFile: input.logFile } : {}),
    ...(input.entryPoints !== undefined ? { entryPoints: input.entryPoints } : {}),
    ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.wakePrompt !== undefined ? { wakePrompt: input.wakePrompt } : {}),
    ...(input.wakePrompt !== undefined && managerApprovalPolicy ? { approvalPolicy: managerApprovalPolicy } : {}),
    ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    ...(input.removeOnExit !== undefined ? { removeOnExit: input.removeOnExit } : {}),
    ...(managerSessionId ? { sessionId: managerSessionId } : {}),
    ...(managerThreadId ? { threadId: managerThreadId } : {})
  });
}

type TodoPlanItemInput = {
  title: string;
  details: string;
  context: string;
  status: "todo" | "active" | "paused" | "hold" | "skipped" | "done" | "blocked";
  activeStatus: string | null;
  children: TodoPlanItemInput[];
};

const todoPlanStatuses = new Set<TodoPlanItemInput["status"]>([
  "todo",
  "active",
  "paused",
  "hold",
  "skipped",
  "done",
  "blocked"
]);
const todoPlanItemKeys = new Set(["id", "title", "details", "context", "status", "activeStatus", "children"]);
const todoSetPlanExample = '{"problem":"Current limitation","objective":"Observable outcome","solution":[{"title":"Implement the change","status":"todo"}],"verification":[{"title":"Verify the outcome","status":"todo"}]}';

function validateTodoPlanItems(value: unknown, field: "solution" | "verification"): TodoPlanItemInput[] {
  if (!Array.isArray(value)) {
    throw invalidTodoPlan(`${field} must be a non-empty array of todo item objects.`);
  }
  if (value.length === 0) {
    throw invalidTodoPlan(`${field} must contain at least one todo item object.`);
  }

  let itemCount = 0;
  const labels = new Map<string, string>();

  const validateItem = (item: unknown, path: string, depth: number): TodoPlanItemInput => {
    if (depth > 20) {
      throw invalidTodoPlan(`${path} exceeds the maximum nesting depth of 20.`);
    }
    const record = readObject(item);
    if (!record) {
      throw invalidTodoPlan(`${path} must be a full todo item object, not a string ID or other value.`);
    }

    itemCount += 1;
    if (itemCount > 200) {
      throw invalidTodoPlan("the complete plan may contain at most 200 items, including nested children.");
    }

    for (const key of Object.keys(record)) {
      if (!todoPlanItemKeys.has(key)) {
        const guidance = key === "parentId" ? " Nest the item inside its parent's children array instead." : "";
        throw invalidTodoPlan(`${path}.${key} is not allowed.${guidance}`);
      }
    }

    if (record.id !== undefined) {
      const label = validateTodoPlanString(record.id, `${path}.id`, 500, false);
      const previousPath = labels.get(label);
      if (previousPath) {
        throw invalidTodoPlan(`${path}.id duplicates the input label at ${previousPath}. Nest each item once and do not repeat nested children at the top level.`);
      }
      labels.set(label, `${path}.id`);
    }

    const title = validateTodoPlanString(record.title, `${path}.title`, 500, false);
    const details = validateOptionalTodoPlanString(record.details, `${path}.details`, 12000, "");
    const context = validateOptionalTodoPlanString(record.context, `${path}.context`, 50000, "");
    const activeStatus = validateOptionalTodoPlanString(record.activeStatus, `${path}.activeStatus`, 1000, null);
    const status = record.status === undefined ? "todo" : validateTodoPlanString(record.status, `${path}.status`, 20, false);
    if (!todoPlanStatuses.has(status as TodoPlanItemInput["status"])) {
      throw invalidTodoPlan(`${path}.status must be one of: ${[...todoPlanStatuses].join(", ")}.`);
    }

    if (record.children !== undefined && !Array.isArray(record.children)) {
      throw invalidTodoPlan(`${path}.children must be an array of full todo item objects, never string IDs.`);
    }
    const children = (record.children ?? []) as unknown[];

    return {
      title,
      details,
      context,
      status: status as TodoPlanItemInput["status"],
      activeStatus,
      children: children.map((child, index) => validateItem(child, `${path}.children[${index}]`, depth + 1))
    };
  };

  return value.map((item, index) => validateItem(item, `${field}[${index}]`, 1));
}

function countTodoPlanItems(items: TodoPlanItemInput[]): number {
  return items.reduce((total, item) => total + 1 + countTodoPlanItems(item.children), 0);
}

function validateTodoPlanString(value: unknown, path: string, maxLength: number, allowEmpty: boolean) {
  if (typeof value !== "string") {
    throw invalidTodoPlan(`${path} must be a string.`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw invalidTodoPlan(`${path} must not be empty.`);
  }
  if (value.length > maxLength) {
    throw invalidTodoPlan(`${path} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function validateOptionalTodoPlanString<T extends string | null>(
  value: unknown,
  path: string,
  maxLength: number,
  fallback: T
): string | T {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw invalidTodoPlan(`${path} must be a string when provided.`);
  }
  if (value.length > maxLength) {
    throw invalidTodoPlan(`${path} must be at most ${maxLength} characters.`);
  }
  return value;
}

function invalidTodoPlan(message: string) {
  return new Error(`Invalid todo_set_plan arguments: ${message} Valid example: ${todoSetPlanExample}`);
}

async function createTodoItemsRecursive(sessionId: string, parentId: string | null, items: TodoPlanItemInput[], section: "solution" | "verification"): Promise<void> {
  let position = 1;
  for (const item of items) {
    const id = `todo_${crypto.randomUUID()}`;
    await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/todos/items`, {
      id,
      parentId,
      title: item.title,
      details: item.details,
      context: item.context,
      section,
      status: item.status,
      position,
      actor: "agent",
      turnId: managerTurnId,
      activeStatus: item.activeStatus
    });
    if (item.children.length > 0) {
      await createTodoItemsRecursive(sessionId, id, item.children, section);
    }
    position += 1;
  }
}

async function postChatStream(payload: unknown) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is not configured.");
  }
  const response = await fetch(`${apiBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const events = parseSseEvents(await response.text());
  const sessionEvents = events.filter((event) => event.type === "session");
  const lastSession = readObject(sessionEvents.at(-1)?.data);
  const result = readObject(events.find((event) => event.type === "result")?.data);
  const pending = readObject(events.find((event) => event.type === "pending")?.data);
  const error = readObject(events.find((event) => event.type === "error")?.data);
  const done = readObject(events.find((event) => event.type === "done")?.data);

  return {
    ok: !error,
    mode: pending ? "pending" : "runner",
    sessionId: readString(lastSession?.sessionId) ?? readString(result?.sessionId) ?? readString(pending?.sessionId),
    threadId: readString(lastSession?.threadId) ?? readString(result?.threadId) ?? readString(pending?.threadId),
    turnId: readString(lastSession?.turnId) ?? readString(result?.turnId) ?? readString(pending?.turnId),
    queued: pending ? pending.queued === true : false,
    reply: readString(result?.reply) ?? null,
    pending: pending ?? null,
    error: error ? readString(error.message) ?? "Prompt runner error." : null,
    done: done ?? null,
    eventCount: events.length
  };
}

function parseSseEvents(text: string) {
  const events: Array<{ type: string; data: unknown }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    let type = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        type = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const rawData = dataLines.join("\n");
    try {
      events.push({ type, data: JSON.parse(rawData) });
    } catch {
      events.push({ type, data: rawData });
    }
  }
  return events;
}

function getStore() {
  store ??= new SessionStore();
  return store;
}

async function getJson(path: string) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is not configured.");
  }
  const response = await fetch(`${apiBaseUrl}${path}`);
  return responseJsonOrThrow(response);
}

async function postJson(path: string, payload: unknown) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is not configured.");
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return responseJsonOrThrow(response);
}

async function patchJson(path: string, payload: unknown) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is not configured.");
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return responseJsonOrThrow(response);
}

async function deleteJson(path: string) {
  if (!apiBaseUrl) {
    throw new Error("SESSION_INSPECTOR_SERVER_URL is not configured.");
  }
  const response = await fetch(`${apiBaseUrl}${path}`, { method: "DELETE" });
  return responseJsonOrThrow(response);
}

async function responseJsonOrThrow(response: Response) {
  const text = await response.text();
  const parsed = text ? parseJson(text) : null;
  if (!response.ok) {
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    const message =
      record && typeof record.error === "string"
        ? record.error
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error)
      }
    ]
  };
}

function writeResponse(id: string | number | null, result: unknown, error?: { code: number; message: string }) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result })
    })}\n`
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTodoPlanSection(value: unknown): "solution" | "verification" | null {
  return value === "solution" || value === "verification" ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function readBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = readString(record[key]);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function readSessionIdArg(record: Record<string, unknown>) {
  const requestedSessionId = readString(record.sessionId);
  if (todoParentSessionId && requestedSessionId && requestedSessionId !== todoParentSessionId) {
    throw new Error("Todo workers may only access their assigned parent todo plan.");
  }
  const sessionId = todoParentSessionId ?? requestedSessionId ?? managerSessionId;
  if (!sessionId) {
    throw new Error("sessionId is required outside a managed Threadex turn.");
  }
  return sessionId;
}

function parseManagerChildSkills(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const skill = readObject(item);
      const name = readString(skill?.name);
      const path = readString(skill?.path);
      return name && path ? [{ name, path }] : [];
    });
  } catch {
    return [];
  }
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function closeAndExit(code: number) {
  rl.close();
  await store?.close();
  process.exit(code);
}
