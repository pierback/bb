import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function commitFile(
  repoPath: string,
  fileName: string,
  contents: string,
  message: string,
): Promise<void> {
  await fs.writeFile(path.join(repoPath, fileName), contents, "utf8");
  await runGit(["add", fileName], { cwd: repoPath });
  await runGit(["commit", "-m", message], { cwd: repoPath });
}

async function createSourceAndWorkspace(): Promise<{
  sourcePath: string;
  workspace: Workspace;
  workspacePath: string;
}> {
  const sourcePath = await makeTempDir("bb-source-freshness-source-");
  const worktreeRoot = await makeTempDir("bb-source-freshness-worktree-");
  const workspacePath = path.join(worktreeRoot, "feature");
  await runGit(["init", "-b", "main"], { cwd: sourcePath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: sourcePath });
  await runGit(["config", "user.email", "bb@example.com"], {
    cwd: sourcePath,
  });
  await commitFile(sourcePath, "README.md", "initial\n", "Initial commit");
  await runGit(["worktree", "add", "-b", "feature", workspacePath, "main"], {
    cwd: sourcePath,
  });
  return { sourcePath, workspace: new Workspace(workspacePath), workspacePath };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0).reverse()) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("workspace source freshness", () => {
  it("reports and fast-forwards a workspace that is behind its source", async () => {
    const { sourcePath, workspace } = await createSourceAndWorkspace();
    await commitFile(sourcePath, "source.txt", "source\n", "Source work");

    await expect(workspace.getSourceFreshness("main")).resolves.toMatchObject({
      sourceBranch: "main",
      currentBranch: "feature",
      state: "behind",
      aheadCount: 0,
      behindCount: 1,
    });

    await expect(
      workspace.updateFromSource({ sourceBranch: "main", mode: "automatic" }),
    ).resolves.toMatchObject({
      updated: true,
      strategy: "fast_forward",
      before: { state: "behind" },
      after: { state: "up_to_date" },
    });
  });

  it("fetches an explicit remote source ref before reporting freshness", async () => {
    const remotePath = await makeTempDir("bb-source-freshness-remote-");
    const sourcePath = await makeTempDir("bb-source-freshness-clone-");
    const publisherPath = await makeTempDir("bb-source-freshness-publisher-");
    const worktreeRoot = await makeTempDir("bb-source-freshness-worktree-");
    const workspacePath = path.join(worktreeRoot, "feature");
    await runGit(["init", "--bare"], { cwd: remotePath });
    await runGit(["clone", remotePath, "."], { cwd: sourcePath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: sourcePath });
    await runGit(["config", "user.email", "bb@example.com"], {
      cwd: sourcePath,
    });
    await runGit(["switch", "-c", "main"], { cwd: sourcePath });
    await commitFile(sourcePath, "README.md", "initial\n", "Initial commit");
    await runGit(["push", "-u", "origin", "main"], { cwd: sourcePath });
    await runGit(
      ["worktree", "add", "-b", "feature", workspacePath, "origin/main"],
      { cwd: sourcePath },
    );

    await runGit(["clone", remotePath, "."], { cwd: publisherPath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: publisherPath });
    await runGit(["config", "user.email", "bb@example.com"], {
      cwd: publisherPath,
    });
    await runGit(["switch", "main"], { cwd: publisherPath });
    await commitFile(publisherPath, "remote.txt", "remote\n", "Remote work");
    await runGit(["push", "origin", "main"], { cwd: publisherPath });

    const workspace = new Workspace(workspacePath);
    await expect(
      workspace.getSourceFreshness("origin/main"),
    ).resolves.toMatchObject({
      sourceBranch: "origin/main",
      state: "behind",
      aheadCount: 0,
      behindCount: 1,
    });
  });

  it("only rebases diverged workspaces in manual mode", async () => {
    const { sourcePath, workspace, workspacePath } =
      await createSourceAndWorkspace();
    await commitFile(workspacePath, "feature.txt", "feature\n", "Feature work");
    await commitFile(sourcePath, "source.txt", "source\n", "Source work");

    await expect(
      workspace.updateFromSource({ sourceBranch: "main", mode: "automatic" }),
    ).resolves.toMatchObject({ updated: false, strategy: "none" });
    await expect(workspace.getSourceFreshness("main")).resolves.toMatchObject({
      state: "diverged",
    });

    await expect(
      workspace.updateFromSource({ sourceBranch: "main", mode: "manual" }),
    ).resolves.toMatchObject({
      updated: true,
      strategy: "rebase",
      after: { state: "ahead", behindCount: 0 },
    });
  });

  it("aborts a conflicting rebase and restores the workspace", async () => {
    const { sourcePath, workspace, workspacePath } =
      await createSourceAndWorkspace();
    await commitFile(
      workspacePath,
      "README.md",
      "feature version\n",
      "Feature edit",
    );
    const originalHead = (
      await runGit(["rev-parse", "HEAD"], {
        cwd: workspacePath,
      })
    ).stdout.trim();
    await commitFile(
      sourcePath,
      "README.md",
      "source version\n",
      "Source edit",
    );

    await expect(
      workspace.updateFromSource({ sourceBranch: "main", mode: "manual" }),
    ).rejects.toMatchObject({ code: "source_update_conflict" });

    await expect(
      runGit(["rev-parse", "HEAD"], { cwd: workspacePath }),
    ).resolves.toMatchObject({ stdout: `${originalHead}\n` });
    await expect(
      fs.readFile(path.join(workspacePath, "README.md"), "utf8"),
    ).resolves.toBe("feature version\n");
    await expect(workspace.getSourceFreshness("main")).resolves.toMatchObject({
      state: "diverged",
      gitOperation: { kind: "none" },
    });
  });

  it("refuses to update a dirty workspace", async () => {
    const { sourcePath, workspace, workspacePath } =
      await createSourceAndWorkspace();
    await commitFile(sourcePath, "source.txt", "source\n", "Source work");
    await fs.writeFile(
      path.join(workspacePath, "dirty.txt"),
      "dirty\n",
      "utf8",
    );

    await expect(
      workspace.updateFromSource({ sourceBranch: "main", mode: "manual" }),
    ).rejects.toMatchObject({
      code: "source_update_dirty",
    });
  });
});
