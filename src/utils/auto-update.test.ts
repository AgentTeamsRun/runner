import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeAutoUpdate, resetAutoUpdateState } from "./auto-update.js";

test("maybeAutoUpdate calls onRunnerUpdated after successful install", async () => {
  resetAutoUpdateState();
  
  let installCalled = false;
  let notifiedVersion: string | null = null;
  
  const deps = {
    runExecutableSync: (name: string, args: string[]) => {
      if (name === "npm" && args[0] === "install") {
        installCalled = true;
      }
      return "";
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    now: () => Date.now(),
    onRunnerUpdated: async (version: string) => {
      notifiedVersion = version;
    }
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: "99.9.9",
  };

  await maybeAutoUpdate(meta, deps);

  assert.ok(installCalled, "installPackage should be called");
  assert.equal(notifiedVersion, "99.9.9", "onRunnerUpdated should be called with new version");
});

test("maybeAutoUpdate does not call onRunnerUpdated again if it already succeeded for that version", async () => {
  resetAutoUpdateState();
  
  let installCount = 0;
  let notifyCount = 0;
  
  const deps = {
    runExecutableSync: () => {
      installCount++;
      return "";
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    now: () => Date.now(),
    onRunnerUpdated: async () => {
      notifyCount++;
    }
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: "99.9.9",
  };

  // First call
  await maybeAutoUpdate(meta, deps);
  assert.equal(installCount, 1);
  assert.equal(notifyCount, 1);

  // Second call with same version
  await maybeAutoUpdate(meta, { ...deps, now: () => Date.now() + 60 * 60 * 1000 + 1 });
  assert.equal(installCount, 1, "should not install again");
  assert.equal(notifyCount, 1, "should not notify again");
});

test("maybeAutoUpdate RETRIES notification if it failed before", async () => {
  resetAutoUpdateState();
  
  let notifyCount = 0;
  let shouldFailNotify = true;
  
  const deps = {
    runExecutableSync: () => "",
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    now: () => 10000000,
    onRunnerUpdated: async () => {
      if (shouldFailNotify) {
        shouldFailNotify = false;
        throw new Error("Network error");
      }
      notifyCount++;
    }
  };

  const meta = {
    cliLatestVersion: null,
    runnerLatestVersion: "99.9.9",
  };

  // First call: install succeeds, notification fails
  console.log("First call starting...");
  await maybeAutoUpdate(meta, deps);
  console.log("First call done. notifyCount:", notifyCount);
  assert.equal(notifyCount, 0, "Notification should have failed");

  // Second call: after cooldown
  console.log("Second call starting...");
  await maybeAutoUpdate(meta, { ...deps, now: () => 10000000 + 60 * 60 * 1000 + 1 });
  console.log("Second call done. notifyCount:", notifyCount);
  
  assert.equal(notifyCount, 1, "Should retry notification successfully");
});
