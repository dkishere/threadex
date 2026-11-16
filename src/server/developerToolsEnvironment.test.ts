import assert from "node:assert/strict";
import test from "node:test";
import { configureDeveloperToolsEnvironment } from "./developerToolsEnvironment";

const licenseFailure = { status: 69, stderr: "You have not agreed to the Xcode license agreements." };
const success = { status: 0, stderr: "" };

test("uses working Command Line Tools when Xcode's license blocks Git", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", KEEP: "value" };
  const calls: NodeJS.ProcessEnv[] = [];
  assert.equal(configureDeveloperToolsEnvironment(env, "darwin", candidate => {
    calls.push({ ...candidate });
    return candidate.DEVELOPER_DIR ? success : licenseFailure;
  }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].DEVELOPER_DIR, undefined);
  assert.deepEqual(env, { PATH: "/usr/bin", KEEP: "value", DEVELOPER_DIR: "/Library/Developer/CommandLineTools" });
});

test("preserves explicit developer tool selection and other platforms", () => {
  for (const [platform, env] of [
    ["darwin", { DEVELOPER_DIR: "/custom/Xcode" }],
    ["linux", {}], ["win32", {}]
  ] as [NodeJS.Platform, NodeJS.ProcessEnv][]) {
    const before = { ...env };
    assert.equal(configureDeveloperToolsEnvironment(env, platform, () => {
      assert.fail("must not probe");
    }), false);
    assert.deepEqual(env, before);
  }
});

test("leaves healthy Git and unrelated Git failures alone", () => {
  for (const result of [success, { status: 1, stderr: "unrelated error" }]) {
    const env = {};
    let calls = 0;
    assert.equal(configureDeveloperToolsEnvironment(env, "darwin", () => { calls++; return result; }), false);
    assert.equal(calls, 1);
    assert.deepEqual(env, {});
  }
});

test("does not select Command Line Tools unless its Git works", () => {
  const env = {};
  let calls = 0;
  assert.equal(configureDeveloperToolsEnvironment(env, "darwin", () => {
    calls++;
    return calls === 1 ? licenseFailure : { status: null, stderr: "missing tools" };
  }), false);
  assert.equal(calls, 2);
  assert.deepEqual(env, {});
});
