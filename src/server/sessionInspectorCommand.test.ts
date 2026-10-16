import assert from "node:assert/strict";
import test from "node:test";
import { approvedInspectorCommand, inspectorApprovalGate, inspectorCommand, inspectorScript } from "./sessionInspectorCommand";

test("CLI approval recognizes exact argv and quoted JSON without accepting shell code", () => {
  const allowed = ["get_session", "todo_set_plan"];
  assert.equal(approvedInspectorCommand(`${inspectorCommand} get '{"sessionId":"s"}'`, allowed), true);
  assert.equal(approvedInspectorCommand([process.execPath, inspectorScript, "todo_set_plan", '{"problem":"$() is data"}'], allowed), true);
  assert.equal(approvedInspectorCommand(["/bin/zsh", "-lc", `${inspectorCommand} help get_session`], allowed), true);
  for (const command of [
    `${inspectorCommand} prompt_session '{}'`,
    `${inspectorCommand} get_session '{}' ; touch /tmp/unwanted`,
    `${inspectorCommand} get_session '{}'\ntouch /tmp/unwanted`,
    `${inspectorCommand} get_session "$(touch /tmp/unwanted)"`,
    `${inspectorCommand} get_session '{}' > /tmp/unwanted`,
    `THREADEX_TODO_AGENT_ROLE=default ${inspectorCommand} get_session '{}'`,
    `${inspectorCommand} get_session --file /tmp/input.json`,
    `${inspectorCommand} get_session --stdin`,
    `${inspectorCommand} get_session '[]'`,
    `node -e 'process.exit()'`
  ]) assert.equal(approvedInspectorCommand(command, allowed), false, command);
});

test("grill read budget survives separate CLI invocations and help does not consume it", () => {
  const approve = inspectorApprovalGate({ env: {}, approvedCommands: ["get_session"], maxCalls: 2 });
  assert.equal(approve(`${inspectorCommand} help get_session`), true);
  assert.equal(approve(`${inspectorCommand} get_session '{}'`), true);
  assert.equal(approve(`${inspectorCommand} get_session '{}'`), true);
  assert.equal(approve(`${inspectorCommand} get_session '{}'`), false);
  assert.equal(approve(`${inspectorCommand} help`), true);
});

test("Manager escalation accepts exact CLI requests but not npm wrappers or unrelated commands", () => {
  const allowed = ["workspace_status", "workspace_search_tasks", "workspace_inspect_task"];
  assert.equal(approvedInspectorCommand(["/bin/zsh", "-lc", `${inspectorCommand} workspace_inspect_task '{"sessionId":"task"}'`], allowed), true);
  assert.equal(approvedInspectorCommand("npm run session-inspector -- workspace_status", allowed), false);
  assert.equal(approvedInspectorCommand(`${inspectorCommand} get_session '{}'`, allowed), false);
  assert.equal(approvedInspectorCommand(`${inspectorCommand} workspace_status '{}' ; touch /tmp/unwanted`, allowed), false);
});

test("Codex serialized shell approvals decode JSON quoting and validate the inner command", () => {
  const allowed = ["workspace_inspect_task"];
  // This is the string form emitted by item/commandExecution/requestApproval.
  const shell = (inner: string) => `/bin/zsh -lc "${inner.replace(/[\\"$`]/g, char => `\\${char}`)}"`;
  const command = `${inspectorCommand} workspace_inspect_task '{"sessionId":"task"}'`;
  assert.equal(approvedInspectorCommand(shell(command), allowed), true);
  assert.equal(approvedInspectorCommand(shell(`${command} ; touch /tmp/unwanted`), allowed), false);
  assert.equal(approvedInspectorCommand(shell(`${command} > /tmp/unwanted`), allowed), false);
  assert.equal(approvedInspectorCommand(shell(`${inspectorCommand} workspace_inspect_task "$(touch /tmp/unwanted)"`), allowed), false);
  assert.equal(approvedInspectorCommand(shell(`${inspectorCommand} workspace_inspect_task "\`touch /tmp/unwanted\`"`), allowed), false);
  assert.equal(approvedInspectorCommand(shell(`${inspectorCommand} workspace_inspect_task '{"sessionId":"literal $() and \` are data"}'`), allowed), true);
});
