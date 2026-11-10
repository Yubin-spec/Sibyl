import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import {
  normalizedPath,
  projectKey,
} from "../src/platform/project-path.mjs";

test("project identity normalizes separators, trailing separators and Windows case", () => {
  assert.equal(
    normalizedPath("C:\\Work\\Repo\\", { platform: "win32" }),
    "c:/work/repo",
  );
  assert.equal(
    normalizedPath("/Users/me/Repo/", { platform: "darwin" }),
    "/Users/me/Repo",
  );
  const cwd = process.cwd();
  assert.equal(projectKey(cwd), projectKey(cwd + sep));
  assert.equal(projectKey(join(cwd, "missing-" + Date.now())), null);
});
