import test from "node:test";
import assert from "node:assert/strict";
import { extractCoActionId } from "./coaction-id.js";

test("extractCoActionId parses valid marker", () => {
  const result = extractCoActionId("done\nCOACTION_ID: 123e4567-e89b-12d3-a456-426614174000\nok");
  assert.equal(result, "123e4567-e89b-12d3-a456-426614174000");
});

test("extractCoActionId returns null for invalid marker", () => {
  const result = extractCoActionId("COACTION_ID: not-a-uuid");
  assert.equal(result, null);
});
