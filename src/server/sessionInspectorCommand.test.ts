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
