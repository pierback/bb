import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "@bb/host-workspace";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectGitWorkspaceEvidence,
  inspectNonGitWorkspaceEvidence,
} from "./session-workspace-evidence.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-session-workspace-evidence-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function initializeGitRepository(): Promise<string> {
  const directory = await createTemporaryDirectory();
  await runGit(["init"], { cwd: directory });
  await fs.writeFile(path.join(directory, "tracked.txt"), "base\n");
  await runGit(["add", "tracked.txt"], { cwd: directory });
  await runGit(
    [
      "-c",
      "user.name=BB Test",
      "-c",
      "user.email=bb-test@example.invalid",
      "commit",
      "-m",
      "base",
    ],
    { cwd: directory },
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("session workspace evidence", () => {
  it("includes hidden non-Git file content", async () => {
    const directory = await createTemporaryDirectory();
    await fs.writeFile(path.join(directory, ".hidden"), "first\n");
    const first = await inspectNonGitWorkspaceEvidence(directory);

    await fs.writeFile(path.join(directory, ".hidden"), "second\n");
    const second = await inspectNonGitWorkspaceEvidence(directory);

    expect(second.diffDigest).not.toBe(first.diffDigest);
    expect(second.untrackedManifestDigest).not.toBe(
      first.untrackedManifestDigest,
    );
  });

  it("distinguishes staged state from the same unstaged content", async () => {
    const directory = await initializeGitRepository();
    await fs.writeFile(path.join(directory, "tracked.txt"), "changed\n");
    await runGit(["add", "tracked.txt"], { cwd: directory });
    const staged = await inspectGitWorkspaceEvidence(directory);

    await runGit(["reset", "--", "tracked.txt"], { cwd: directory });
    const unstaged = await inspectGitWorkspaceEvidence(directory);

    expect(unstaged.indexDigest).not.toBe(staged.indexDigest);
    expect(unstaged.diffDigest).not.toBe(staged.diffDigest);
  });

  it("includes untracked file content, including dotfiles", async () => {
    const directory = await initializeGitRepository();
    await fs.writeFile(path.join(directory, ".untracked"), "first\n");
    const first = await inspectGitWorkspaceEvidence(directory);

    await fs.writeFile(path.join(directory, ".untracked"), "second\n");
    const second = await inspectGitWorkspaceEvidence(directory);

    expect(second.untrackedManifestDigest).not.toBe(
      first.untrackedManifestDigest,
    );
  });
});
