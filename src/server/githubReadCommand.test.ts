import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedGitHubReadCommand, githubReadArgv, githubReadEnvironment, resolveGitHubReadCli } from "./githubReadCommand";

const config = { executable: "/trusted/bin/gh", configDir: "/host/.config/gh", hostHome: "/host" };
const command = (args: string) => `'${config.executable}' ${args}`;

test("GitHub helper preserves the login config across HOME isolation", () => {
  const root = mkdtempSync(join(tmpdir(), "github-read-command-"));
  writeFileSync(join(root, "gh"), "", { mode: 0o755 });
  try {
    const found = resolveGitHubReadCli({ PATH: root, HOME: root });
    assert.deepEqual(found, { executable: join(root, "gh"), configDir: join(root, ".config/gh"), hostHome: root });
    assert.equal(githubReadEnvironment(found!).GH_CONFIG_DIR, join(root, ".config/gh"));
    assert.equal(resolveGitHubReadCli({ PATH: root, XDG_CONFIG_HOME: "/xdg" })?.configDir, "/xdg/gh");
    assert.equal(resolveGitHubReadCli({ PATH: root, XDG_CONFIG_HOME: "/xdg", GH_CONFIG_DIR: "/custom/gh" })?.configDir, "/custom/gh");
    assert.equal(resolveGitHubReadCli({ PATH: "." }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GitHub credential wrapper accepts only the pinned home and executable", () => {
  const prefix = githubReadArgv(config);
  assert.equal(approvedGitHubReadCommand([...prefix, "pr", "view", "14", "--repo", "owner/repo"], config), true);
  assert.equal(approvedGitHubReadCommand([...prefix, "pr", "merge", "14"], config), false);
  assert.equal(approvedGitHubReadCommand([prefix[0], prefix[1], "/other-home", config.executable, "pr", "view", "14"], config), false);
  assert.equal(approvedGitHubReadCommand([prefix[0], prefix[1], config.hostHome, "/tmp/gh", "pr", "view", "14"], config), false);
});

test("GitHub read approvals support PR details and paginated review comments", () => {
  for (const args of [
    "pr view 14 --repo owner/repo --json title,body,url,comments,reviews,files",
    "pr view https://github.com/owner/repo/pull/14 --comments",
    "pr view --help", "pr diff 14 --repo=owner/repo --patch", "pr checks 14 -R owner/repo --json name,state",
    "api repos/owner/repo/pulls/14/comments --paginate --jq '.[].body'",
    "api --method=GET /repos/owner/repo/issues/14/comments --paginate --slurp",
    "api 'repos/owner/repo/pulls/14/reviews?per_page=100&page=2' -X GET",
    "api repos/owner/repo/pulls/14/reviews/99/comments", "api repos/owner/repo/pulls/14/files", "api --help"
  ]) {
    assert.equal(approvedGitHubReadCommand(command(args), config), true, args);
    assert.equal(approvedGitHubReadCommand(["/bin/zsh", "-lc", command(args)], config), true, args);
  }
});

test("GitHub read approvals reject writes, credential exposure, arbitrary network and shell code", () => {
  for (const args of [
    "pr merge 14", "pr review 14 --approve", "pr comment 14 --body hello", "pr edit 14 --title hello",
    "pr view 14 --web", "auth token", "auth status --show-token", "alias set test '!touch /tmp/unwanted'",
    "api repos/owner/repo/pulls/14/comments -X POST", "api repos/owner/repo/pulls/14 -X PATCH",
    "api repos/owner/repo/pulls/14 -X GET -X DELETE", "api repos/owner/repo/pulls/14 --method=POST",
    "api repos/owner/repo/pulls/14/comments -f body=hello", "api repos/owner/repo/pulls/14 -F secret=@/etc/passwd",
    "api repos/owner/repo/pulls/14 --input /etc/passwd", "api repos/owner/repo/pulls/14 --hostname example.com",
    "api repos/owner/repo/pulls/14 -H 'Authorization: token secret'", "api graphql -f 'query=mutation { ... }'",
    "api https://example.com", "pr view 14; curl https://example.com", "pr view 14 > /tmp/output",
    'pr view 14 --jq "$(touch /tmp/unwanted)"', "pr view 14 --json --web", "pr view 14 15"
  ]) assert.equal(approvedGitHubReadCommand(command(args), config), false, args);
  assert.equal(approvedGitHubReadCommand("GH_CONFIG_DIR=/tmp gh pr view 14", config), false);
  assert.equal(approvedGitHubReadCommand("/tmp/gh pr view 14", config), false);
});
