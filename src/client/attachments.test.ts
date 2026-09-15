import assert from "node:assert/strict";
import test from "node:test";
import { isKnownTextAttachment, normalizeStoredUserInput } from "./attachments";

test("normalizes native attachment summaries into stored attachment cards", () => {
  const result = normalizeStoredUserInput(
    "check this\n\n[Attached files]\n- image.png (image/png, 130982 bytes)",
    "turn-1"
  );

  assert.equal(result.content, "check this");
  assert.deepEqual(result.attachments[0], {
    id: "turn-1:attachment:0",
    name: "image.png",
    type: "image/png",
    size: 130982,
    path: "turn-1/01-image.png",
    fileUrl: "/api/attachments/file?path=turn-1%2F01-image.png"
  });
});

test("normalizes imported image manifests and hides the image tag", () => {
  const path = "/Volumes/dev/tools/session-manager/data/uploads/imported/01-image.png";
  const result = normalizeStoredUserInput(
    `check this\n\nAttached files:\n- image.png (image/png, 130982 bytes, ${path}) <image name=[Image #1] path="${path}">\n</image>`,
    "imported-turn"
  );

  assert.equal(result.content, "check this");
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.path, path);
  assert.equal(result.attachments[0]?.fileUrl, `/api/attachments/file?path=${encodeURIComponent(path)}`);
});

test("recognizes text attachments by MIME type or known file extension", () => {
  const attachment = (name: string, type = "application/octet-stream") => ({ id: name, name, type, size: 10 });

  assert.equal(isKnownTextAttachment(attachment("notes.unknown", "text/plain")), true);
  assert.equal(isKnownTextAttachment(attachment("config.json")), true);
  assert.equal(isKnownTextAttachment(attachment("Dockerfile")), true);
  assert.equal(isKnownTextAttachment(attachment("photo.png", "image/png")), false);
  assert.equal(isKnownTextAttachment(attachment("archive.zip", "application/zip")), false);
});
