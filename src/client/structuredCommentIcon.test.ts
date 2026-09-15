import assert from "node:assert/strict";
import test from "node:test";
import { structuredCommentIcon } from "./sessionHelpers02.js";

test("uses search for action comments and keeps verification distinct", () => {
  const icons = {
    CheckCircle2: () => null,
    Lightbulb: () => null,
    MessageSquare: () => null,
    Pencil: () => null,
    Search: () => null,
    TriangleAlert: () => null
  };

  assert.equal(structuredCommentIcon(icons, "action"), icons.Search);
  assert.equal(structuredCommentIcon(icons, "verification"), icons.CheckCircle2);
});
