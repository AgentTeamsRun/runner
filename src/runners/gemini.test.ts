import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiExecArgs } from "./gemini.js";

test("buildGeminiExecArgs places prompt immediately after -p with -y flag", () => {
  assert.deepEqual(buildGeminiExecArgs("hello", "gemini-2.5-pro"), [
    "-y",
    "--sandbox=false",
    "--include-directories",
    ".agentteams",
    "-p",
    "hello",
    "--model",
    "gemini-2.5-pro"
  ]);
});

test("buildGeminiExecArgs omits model arguments when model is missing", () => {
  assert.deepEqual(buildGeminiExecArgs("hello", null), ["-y", "--sandbox=false", "--include-directories", ".agentteams", "-p", "hello"]);
});
