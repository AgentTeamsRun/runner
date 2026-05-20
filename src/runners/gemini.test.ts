import assert from "node:assert/strict";
import test from "node:test";
import { annotateGeminiSunsetError, buildGeminiExecArgs, GEMINI_SUNSET_NOTICE } from "./gemini.js";

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

test("annotateGeminiSunsetError appends sunset notice for quota/auth failures", () => {
  const result = annotateGeminiSunsetError("Error: quota exceeded for free tier accounts");
  assert.ok(result?.includes(GEMINI_SUNSET_NOTICE));
  assert.ok(result?.startsWith("Error: quota exceeded"));
});

test("annotateGeminiSunsetError leaves unrelated errors untouched", () => {
  const message = "Runner idle timed out after 60m of no output";
  assert.equal(annotateGeminiSunsetError(message), message);
});

test("annotateGeminiSunsetError does not double-annotate messages that already mention the sunset date", () => {
  const message = `existing error\n${GEMINI_SUNSET_NOTICE}`;
  assert.equal(annotateGeminiSunsetError(message), message);
});

test("annotateGeminiSunsetError returns undefined for empty input", () => {
  assert.equal(annotateGeminiSunsetError(undefined), undefined);
});
