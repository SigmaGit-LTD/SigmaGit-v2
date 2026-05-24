import git from "isomorphic-git";
import { createS3Fs, type S3Fs } from "./s3-fs";
import { getRepoPrefix } from "../s3";
import { getCached, setCache, repoCache, CACHE_TTL } from "../redis";
import { MAX_FILE_CACHE_BYTES, MAX_FILE_SERVE_BYTES, MAX_DIFF_FILES, MAX_DIFF_FILE_BYTES, MAX_DIFF_LINES } from "../middleware/limits";

export interface CommitAuthor {
  name: string;
  email: string;
  username?: string;
  userId?: string;
  avatarUrl?: string | null;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: CommitAuthor;
  timestamp: number;
}

export interface TreeEntry {
  name: string;
  mode: string;
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit" | string;
}

export interface DiffHunkLine {
  type: "context" | "addition" | "deletion";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated?: boolean;
  binary?: boolean;
}

export interface CommitDiff {
  commit: CommitInfo;
  parent: string | null;
  files: FileDiff[];
  stats: {
    additions: number;
    deletions: number;
    filesChanged: number;
    truncatedFiles?: number;
  };
}

export interface GitStore {
  fs: S3Fs;
  dir: string;
  ownerId: string;
  repoName: string;
}

export function createGitStore(ownerId: string, repoName: string): GitStore {
  const prefix = getRepoPrefix(ownerId, repoName);
  const fs = createS3Fs(prefix);
  return { fs, dir: "/", ownerId, repoName };
}

export async function listBranches(fs: S3Fs, dir: string): Promise<string[]> {
  try {
    const branches = await git.listBranches({ fs, dir });
    if (branches.length > 0) {

      return branches;
    }
  } catch (error) {
    console.error(`[Git] listBranches error:`, error);
  }

  try {
    const refsDir = "refs/heads";
    const entries = await fs.promises.readdir(refsDir);
    const branches: string[] = [];

    for (const entry of entries) {
      const refPath = `${refsDir}/${entry}`;
      try {
        const refContent = await fs.promises.readFile(refPath, "utf8");

        branches.push(entry);
      } catch (error) {
        console.error(`[Git] listBranches: failed to read ${refPath}:`, error);
        continue;
      }
    }


    return branches;
  } catch (error) {
    console.error(`[Git] listBranches (manual) error:`, error);
    return [];
  }
}

function normalizeRef(ref: string): string {
  if (ref.startsWith("refs/")) {
    return ref;
  }
  if (ref === "HEAD") {
    return "HEAD";
  }
  return `refs/heads/${ref}`;
}

export async function refExists(fs: S3Fs, dir: string, ref: string): Promise<boolean> {
  try {
    const normalizedRef = normalizeRef(ref);
    const resolved = await git.resolveRef({ fs, dir, ref: normalizedRef });

    return true;
  } catch (error) {
    try {
      const refPath = normalizeRef(ref);
      const content = await fs.promises.readFile(refPath, "utf8");

      return content.toString().trim().length === 40;
    } catch (readError) {
      return false;
    }
  }
}

async function objectExists(fs: S3Fs, oid: string): Promise<boolean> {
  try {
    const prefix = oid.substring(0, 2);
    const suffix = oid.substring(2);
    const objectPath = `.git/objects/${prefix}/${suffix}`;
    await fs.promises.stat(objectPath);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT" || error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    return false;
  }
}

export async function getCommits(
  fs: S3Fs,
  dir: string,
  ref: string,
  limit: number,
  skip: number
): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
  try {
    const normalizedRef = normalizeRef(ref);
    const exists = await refExists(fs, dir, ref);
    if (!exists) {

      return { commits: [], hasMore: false };
    }



    let commitOid: string;
    try {
      commitOid = await git.resolveRef({ fs, dir, ref: normalizedRef });
    } catch (error) {
      console.error(`[Git] getCommits: resolveRef failed, trying manual read:`, error);
      try {
        const refContent = await fs.promises.readFile(normalizedRef, "utf8");
        commitOid = refContent.toString().trim();

      } catch (readError) {
        console.error(`[Git] getCommits: failed to read ref manually:`, readError);
        return { commits: [], hasMore: false };
      }
    }

    if (!(await objectExists(fs, commitOid))) {
      console.error(`[Git] getCommits: commit ${commitOid} does not exist`);
      return { commits: [], hasMore: false };
    }

    const commits: CommitInfo[] = [];
    let count = 0;
    let skipped = 0;
    let currentOid: string | null = commitOid;
    let hasMore = false;

    while (currentOid && count < limit + skip) {
      try {
        const { commit } = await git.readCommit({ fs, dir, oid: currentOid });

        if (skipped >= skip) {
          if (count < limit) {
            commits.push({
              oid: currentOid,
              message: commit.message,
              author: {
                name: commit.author.name,
                email: commit.author.email,
              },
              timestamp: commit.author.timestamp * 1000,
            });
            count++;
          } else {
            hasMore = true;
            break;
          }
        } else {
          skipped++;
        }

        currentOid = commit.parent.length > 0 ? commit.parent[0] : null;
      } catch (error: any) {
        if (error.code === "NotFoundError" || error.message?.includes("Could not find")) {
          break;
        }
        throw error;
      }
    }

    return { commits, hasMore };
  } catch (error) {
    console.error("[Git] getCommits error:", error);
    return { commits: [], hasMore: false };
  }
}

export async function getCommitCount(fs: S3Fs, dir: string, ref: string): Promise<number> {
  try {
    const normalizedRef = normalizeRef(ref);
    const exists = await refExists(fs, dir, ref);
    if (!exists) {
      return 0;
    }

    let commitOid: string;
    try {
      commitOid = await git.resolveRef({ fs, dir, ref: normalizedRef });
    } catch (error) {
      try {
        const refContent = await fs.promises.readFile(normalizedRef, "utf8");
        commitOid = refContent.toString().trim();
      } catch {
        return 0;
      }
    }

    if (!(await objectExists(fs, commitOid))) {
      return 0;
    }

    let count = 0;
    let currentOid: string | null = commitOid;

    while (currentOid) {
      try {
        const { commit } = await git.readCommit({ fs, dir, oid: currentOid });
        count++;
        currentOid = commit.parent.length > 0 ? commit.parent[0] : null;
      } catch (error: any) {
        if (error.code === "NotFoundError" || error.message?.includes("Could not find")) {
          break;
        }
        throw error;
      }
    }

    return count;
  } catch (error) {
    console.error("[Git] getCommitCount error:", error);
    return 0;
  }
}

export async function getTree(
  fs: S3Fs,
  dir: string,
  ref: string,
  filepath: string
): Promise<TreeEntry[] | null> {
  try {
    const normalizedRef = normalizeRef(ref);
    const exists = await refExists(fs, dir, ref);
    if (!exists) {
      return null;
    }

    let commitOid: string;
    try {
      commitOid = await git.resolveRef({ fs, dir, ref: normalizedRef });
    } catch (error) {
      try {
        const refContent = await fs.promises.readFile(normalizedRef, "utf8");
        commitOid = refContent.toString().trim();
      } catch {
        return null;
      }
    }

    if (!(await objectExists(fs, commitOid))) {
      return null;
    }

    const { commit } = await git.readCommit({ fs, dir, oid: commitOid });

    let treeOid = commit.tree;

    if (filepath && filepath !== "") {
      const parts = filepath.split("/").filter(Boolean);
      for (const part of parts) {
        const tree = await git.readTree({ fs, dir, oid: treeOid });
        const entry = tree.tree.find((e) => e.path === part);
        if (!entry || entry.type !== "tree") {
          return null;
        }
        treeOid = entry.oid;
      }
    }

    const tree = await git.readTree({ fs, dir, oid: treeOid });

    const entries: TreeEntry[] = tree.tree.map((entry) => ({
      mode: entry.mode,
      name: entry.path,
      path: filepath ? `${filepath}/${entry.path}` : entry.path,
      oid: entry.oid,
      type: entry.type === "blob" ? "blob" : "tree",
    }));

    entries.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "tree" ? -1 : 1;
    });

    return entries;
  } catch (error) {
    console.error("[Git] getTree error:", error);
    return null;
  }
}

export async function getFile(
  fs: S3Fs,
  dir: string,
  ref: string,
  filepath: string
): Promise<{ content: string; oid: string } | null> {
  try {
    const normalizedRef = normalizeRef(ref);
    const exists = await refExists(fs, dir, ref);
    if (!exists) {
      return null;
    }

    let commitOid: string;
    try {
      commitOid = await git.resolveRef({ fs, dir, ref: normalizedRef });
    } catch (error) {
      try {
        const refContent = await fs.promises.readFile(normalizedRef, "utf8");
        commitOid = refContent.toString().trim();
      } catch {
        return null;
      }
    }

    if (!(await objectExists(fs, commitOid))) {
      return null;
    }

    const { commit } = await git.readCommit({ fs, dir, oid: commitOid });

    const parts = filepath.split("/").filter(Boolean);
    let treeOid = commit.tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const tree = await git.readTree({ fs, dir, oid: treeOid });
      const entry = tree.tree.find((e) => e.path === parts[i]);
      if (!entry || entry.type !== "tree") {
        return null;
      }
      treeOid = entry.oid;
    }

    const tree = await git.readTree({ fs, dir, oid: treeOid });
    const filename = parts[parts.length - 1];
    const fileEntry = tree.tree.find((e) => e.path === filename && e.type === "blob");

    if (!fileEntry) {
      return null;
    }

    try {
      const objectPath = `${dir}/objects/${fileEntry.oid.slice(0, 2)}/${fileEntry.oid.slice(2)}`;
      const stats = await fs.promises.stat(objectPath);
      if (stats.size * 8 > MAX_FILE_SERVE_BYTES) {
        return null;
      }
    } catch {
      // stat unavailable — enforce limit after read instead
    }

    const { blob } = await git.readBlob({ fs, dir, oid: fileEntry.oid });
    if (blob.length > MAX_FILE_SERVE_BYTES) {
      return null;
    }
    const content = new TextDecoder().decode(blob);

    return { content, oid: fileEntry.oid };
  } catch (error) {
    console.error("[Git] getFile error:", error);
    return null;
  }
}

export async function getBlobByOid(
  fs: S3Fs,
  dir: string,
  oid: string
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

export async function getCommitByOid(
  fs: S3Fs,
  dir: string,
  oid: string
): Promise<{ commit: CommitInfo; parent: string | null } | null> {
  try {

    const { commit } = await git.readCommit({ fs, dir, oid });
    return {
      commit: {
        oid,
        message: commit.message,
        author: {
          name: commit.author.name,
          email: commit.author.email,
        },
        timestamp: commit.author.timestamp * 1000,
      },
      parent: commit.parent.length > 0 ? commit.parent[0] : null,
    };
  } catch (error) {
    console.error(`[Git] getCommitByOid error for ${oid}:`, error);
    return null;
  }
}

interface ChangedFile {
  path: string;
  status: string;
  oldOid: string | null;
  newOid: string | null;
}

async function compareTreesRecursive(
  fs: S3Fs,
  dir: string,
  parentTreeOid: string | null,
  currentTreeOid: string,
  basePath: string
): Promise<ChangedFile[]> {
  const results: ChangedFile[] = [];

  const currentEntries: TreeEntry[] = [];
  const parentEntries: TreeEntry[] = [];

  try {
    const currentTree = await git.readTree({ fs, dir, oid: currentTreeOid });
    for (const entry of currentTree.tree) {
      currentEntries.push(entry as TreeEntry);
    }
  } catch (e) {
    console.error(`[Git] compareTreesRecursive: failed to read current tree ${currentTreeOid}:`, e);
    return results;
  }

  if (parentTreeOid) {
    try {
      const parentTree = await git.readTree({ fs, dir, oid: parentTreeOid });
      for (const entry of parentTree.tree) {
        parentEntries.push(entry as TreeEntry);
      }
    } catch (e) {
      console.error(`[Git] compareTreesRecursive: failed to read parent tree ${parentTreeOid}:`, e);
    }
  }

  const parentMap = new Map<string, TreeEntry>();
  for (const entry of parentEntries) {
    parentMap.set(entry.path, entry);
  }

  const currentMap = new Map<string, TreeEntry>();
  for (const entry of currentEntries) {
    currentMap.set(entry.path, entry);
  }

  for (const entry of currentEntries) {
    const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
    const parentEntry = parentMap.get(entry.path);

    if (!parentEntry) {
      if (entry.type === "blob") {
        results.push({ path: fullPath, status: "added", oldOid: null, newOid: entry.oid });
      } else if (entry.type === "tree") {
        const subResults = await compareTreesRecursive(fs, dir, null, entry.oid, fullPath);
        results.push(...subResults);
      }
    } else if (parentEntry.oid !== entry.oid) {
      if (entry.type === "blob" && parentEntry.type === "blob") {
        results.push({ path: fullPath, status: "modified", oldOid: parentEntry.oid, newOid: entry.oid });
      } else if (entry.type === "tree" && parentEntry.type === "tree") {
        const subResults = await compareTreesRecursive(fs, dir, parentEntry.oid, entry.oid, fullPath);
        results.push(...subResults);
      } else {
        results.push({ path: fullPath, status: "modified", oldOid: parentEntry.oid, newOid: entry.oid });
      }
    }
  }

  for (const entry of parentEntries) {
    if (!currentMap.has(entry.path)) {
      const fullPath = basePath ? `${basePath}/${entry.path}` : entry.path;
      if (entry.type === "blob") {
        results.push({ path: fullPath, status: "deleted", oldOid: entry.oid, newOid: null });
      } else if (entry.type === "tree") {
        const subResults = await compareTreesRecursive(fs, dir, entry.oid, entry.oid, fullPath);
        for (const r of subResults) {
          results.push({ path: r.path, status: "deleted", oldOid: r.oldOid, newOid: null });
        }
      }
    }
  }

  return results;
}

async function getBlobInflatedSizeEstimate(fs: S3Fs, dir: string, oid: string): Promise<number | null> {
  try {
    const objectPath = `${dir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    const stats = await fs.promises.stat(objectPath);
    return stats.size * 8;
  } catch {
    try {
      const { blob } = await git.readBlob({ fs, dir, oid });
      return blob.length;
    } catch {
      return null;
    }
  }
}

async function readBlobTextLimited(
  fs: S3Fs,
  dir: string,
  oid: string
): Promise<{ content: string; binary: boolean } | null> {
  const sizeEstimate = await getBlobInflatedSizeEstimate(fs, dir, oid);
  if (sizeEstimate != null && sizeEstimate > MAX_DIFF_FILE_BYTES) {
    return null;
  }

  const { blob } = await git.readBlob({ fs, dir, oid });
  if (blob.length > MAX_DIFF_FILE_BYTES) {
    return null;
  }

  const content = new TextDecoder().decode(blob);
  const binary = content.includes('\0');
  return { content, binary };
}

function capDiffLines(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) {
    return lines;
  }
  return lines.slice(0, MAX_DIFF_LINES);
}

async function generateDiffHunks(
  fs: S3Fs,
  dir: string,
  oldOid: string | null,
  newOid: string | null,
  status: string
): Promise<{ hunks: DiffHunk[]; truncated: boolean; binary: boolean }> {
  try {
    let oldContent = "";
    let newContent = "";
    let binary = false;
    let truncated = false;

    if (oldOid) {
      const oldBlob = await readBlobTextLimited(fs, dir, oldOid);
      if (!oldBlob) {
        return { hunks: [], truncated: true, binary: false };
      }
      if (oldBlob.binary) binary = true;
      oldContent = oldBlob.content;
    }

    if (newOid) {
      const newBlob = await readBlobTextLimited(fs, dir, newOid);
      if (!newBlob) {
        return { hunks: [], truncated: true, binary: binary || false };
      }
      if (newBlob.binary) binary = true;
      newContent = newBlob.content;
    }

    if (binary) {
      return { hunks: [], truncated: false, binary: true };
    }

    const oldLines = capDiffLines(oldContent ? oldContent.split("\n") : []);
    const newLines = capDiffLines(newContent ? newContent.split("\n") : []);
    if (
      (oldContent && oldContent.split("\n").length > MAX_DIFF_LINES) ||
      (newContent && newContent.split("\n").length > MAX_DIFF_LINES)
    ) {
      truncated = true;
    }

    if (status === "added") {
      if (newLines.length === 0) return { hunks: [], truncated, binary: false };
      return {
        truncated,
        binary: false,
        hunks: [{
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: newLines.length,
          lines: newLines.map((content, i) => ({
            type: "addition" as const,
            content,
            newLineNumber: i + 1,
          })),
        }],
      };
    }

    if (status === "deleted") {
      if (oldLines.length === 0) return { hunks: [], truncated, binary: false };
      return {
        truncated,
        binary: false,
        hunks: [{
          oldStart: 1,
          oldLines: oldLines.length,
          newStart: 0,
          newLines: 0,
          lines: oldLines.map((content, i) => ({
            type: "deletion" as const,
            content,
            oldLineNumber: i + 1,
          })),
        }],
      };
    }

    const hunks: DiffHunk[] = [];
    const diffResult = simpleDiff(oldLines, newLines);

    if (diffResult.length > 0) {
      let currentHunk: DiffHunk | null = null;

      for (const change of diffResult) {
        if (!currentHunk || change.oldLine > (currentHunk.oldStart + currentHunk.oldLines + 3)) {
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = {
            oldStart: Math.max(1, change.oldLine - 3),
            oldLines: 0,
            newStart: Math.max(1, change.newLine - 3),
            newLines: 0,
            lines: [],
          };
        }

        if (change.type === "delete") {
          currentHunk.lines.push({
            type: "deletion",
            content: change.content,
            oldLineNumber: change.oldLine,
          });
          currentHunk.oldLines++;
        } else if (change.type === "insert") {
          currentHunk.lines.push({
            type: "addition",
            content: change.content,
            newLineNumber: change.newLine,
          });
          currentHunk.newLines++;
        }
      }

      if (currentHunk) hunks.push(currentHunk);
    }

    return { hunks, truncated, binary: false };
  } catch (e) {
    console.error(`[Git] generateDiffHunks error:`, e);
    return { hunks: [], truncated: false, binary: false };
  }
}

async function buildFileDiff(
  fs: S3Fs,
  dir: string,
  file: { path: string; status: string; oldOid: string | null; newOid: string | null }
): Promise<FileDiff> {
  const result = await generateDiffHunks(fs, dir, file.oldOid, file.newOid, file.status);
  let additionCount = 0;
  let deletionCount = 0;
  for (const hunk of result.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "addition") additionCount++;
      if (line.type === "deletion") deletionCount++;
    }
  }

  return {
    path: file.path,
    status: file.status as FileDiff["status"],
    additions: additionCount,
    deletions: deletionCount,
    hunks: result.hunks,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.binary ? { binary: true } : {}),
  };
}

async function processChangedFiles(
  fs: S3Fs,
  dir: string,
  changedFiles: Array<{ path: string; status: string; oldOid: string | null; newOid: string | null }>
): Promise<{
  files: FileDiff[];
  stats: { additions: number; deletions: number; filesChanged: number; truncatedFiles?: number };
}> {
  const files: FileDiff[] = [];
  let additions = 0;
  let deletions = 0;
  const truncatedFiles = Math.max(0, changedFiles.length - MAX_DIFF_FILES);

  for (const file of changedFiles.slice(0, MAX_DIFF_FILES)) {
    const fileDiff = await buildFileDiff(fs, dir, file);
    additions += fileDiff.additions;
    deletions += fileDiff.deletions;
    files.push(fileDiff);
  }

  return {
    files,
    stats: {
      additions,
      deletions,
      filesChanged: changedFiles.length,
      ...(truncatedFiles > 0 ? { truncatedFiles } : {}),
    },
  };
}

interface DiffChange {
  type: "insert" | "delete";
  content: string;
  oldLine: number;
  newLine: number;
}

function simpleDiff(oldLines: string[], newLines: string[]): DiffChange[] {
  const changes: DiffChange[] = [];

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (oldIdx >= oldLines.length) {
      changes.push({
        type: "insert",
        content: newLines[newIdx],
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
      });
      newIdx++;
    } else if (newIdx >= newLines.length) {
      changes.push({
        type: "delete",
        content: oldLines[oldIdx],
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
      });
      oldIdx++;
    } else if (oldLines[oldIdx] === newLines[newIdx]) {
      oldIdx++;
      newIdx++;
    } else if (!newSet.has(oldLines[oldIdx])) {
      changes.push({
        type: "delete",
        content: oldLines[oldIdx],
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
      });
      oldIdx++;
    } else if (!oldSet.has(newLines[newIdx])) {
      changes.push({
        type: "insert",
        content: newLines[newIdx],
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
      });
      newIdx++;
    } else {
      changes.push({
        type: "delete",
        content: oldLines[oldIdx],
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
      });
      oldIdx++;
    }
  }

  return changes;
}

export async function getCommitDiff(
  fs: S3Fs,
  dir: string,
  oid: string
): Promise<CommitDiff | null> {
  try {
    if (!(await objectExists(fs, oid))) {
      return null;
    }

    const { commit } = await git.readCommit({ fs, dir, oid });

    const parentOid = commit.parent.length > 0 ? commit.parent[0] : null;

    const commitInfo: CommitInfo = {
      oid,
      message: commit.message,
      author: {
        name: commit.author.name,
        email: commit.author.email,
      },
      timestamp: commit.author.timestamp * 1000,
    };

    const files: FileDiff[] = [];
    let additions = 0;
    let deletions = 0;

    try {
      const currentTree = commit.tree;
      let parentTree: string | null = null;

      if (parentOid && await objectExists(fs, parentOid)) {
        try {
          const parentCommit = await git.readCommit({ fs, dir, oid: parentOid });
          parentTree = parentCommit.commit.tree;
        } catch (error: any) {
          if (error.code === "NotFoundError" || error.message?.includes("Could not find")) {
            parentTree = null;
          } else {
            throw error;
          }
        }
      }



      const changedFiles = await compareTreesRecursive(fs, dir, parentTree, currentTree, "");
      const processed = await processChangedFiles(fs, dir, changedFiles);
      files.push(...processed.files);
      additions = processed.stats.additions;
      deletions = processed.stats.deletions;

      return {
        commit: commitInfo,
        parent: parentOid,
        files,
        stats: processed.stats,
      };
    } catch (walkError) {
      console.error(`[Git] getCommitDiff walk error:`, walkError);
    }

    return {
      commit: commitInfo,
      parent: parentOid,
      files,
      stats: {
        additions,
        deletions,
        filesChanged: files.length,
      },
    };
  } catch (error) {
    console.error(`[Git] getCommitDiff error for ${oid}:`, error);
    return null;
  }
}

export async function getRefsAdvertisement(
  fs: S3Fs,
  dir: string,
  service: string
): Promise<Buffer> {
  try {
    const refs: string[] = [];
    const capabilities =
      service === "git-upload-pack"
        ? "symref=HEAD:refs/heads/main agent=sigmagit/1.0"
        : "report-status report-status-v2 delete-refs quiet atomic ofs-delta push-options object-format=sha1 agent=sigmagit/1.0";

    const branches = await git.listBranches({ fs, dir });
    let headOid: string | null = null;

    try {
      headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    } catch {
      headOid = null;
    }

    let first = true;
    for (const branch of branches) {
      try {
        const normalizedBranch = normalizeRef(branch);
        const oid = await git.resolveRef({ fs, dir, ref: normalizedBranch });
        const refName = `refs/heads/${branch}`;

        if (first) {
          refs.push(`${oid} ${refName}\0${capabilities}\n`);
          first = false;
        } else {
          refs.push(`${oid} ${refName}\n`);
        }
      } catch {
        continue;
      }
    }

    if (refs.length === 0 && headOid) {
      refs.push(`${headOid} refs/heads/main\0${capabilities}\n`);
    }

    if (refs.length === 0) {
      const zeroOid = "0".repeat(40);
      refs.push(`${zeroOid} capabilities^{}\0${capabilities}\n`);
    }

    const lines: Buffer[] = [];
    for (const line of refs) {
      const len = line.length + 4;
      const lenHex = len.toString(16).padStart(4, "0");
      lines.push(Buffer.from(lenHex + line));
    }
    lines.push(Buffer.from("0000"));

    return Buffer.concat(lines);
  } catch {
    const zeroOid = "0".repeat(40);
    const capabilities = "agent=sigmagit/1.0";
    const line = `${zeroOid} capabilities^{}\0${capabilities}\n`;
    const len = line.length + 4;
    const lenHex = len.toString(16).padStart(4, "0");
    return Buffer.from(lenHex + line + "0000");
  }
}

export async function listBranchesCached(store: GitStore): Promise<string[]> {
  const cacheKey = repoCache.branchesKey(store.ownerId, store.repoName);
  const cached = await getCached<string[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const branches = await listBranches(store.fs, store.dir);
  await setCache(cacheKey, branches, CACHE_TTL.branches);
  return branches;
}

export async function getCommitsCached(
  store: GitStore,
  ref: string,
  limit: number,
  skip: number
): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
  const cacheKey = repoCache.commitsKey(store.ownerId, store.repoName, ref, limit, skip);
  const cached = await getCached<{ commits: CommitInfo[]; hasMore: boolean }>(cacheKey);
  if (cached && cached.commits && cached.commits.length > 0) {
    return cached;
  }

  const result = await getCommits(store.fs, store.dir, ref, limit, skip);
  if (result.commits.length > 0) {
    await setCache(cacheKey, result, CACHE_TTL.commits);
  }
  return result;
}

export async function getCommitCountCached(store: GitStore, ref: string): Promise<number> {
  const cacheKey = repoCache.commitCountKey(store.ownerId, store.repoName, ref);
  const cached = await getCached<number>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const count = await getCommitCount(store.fs, store.dir, ref);
  if (count > 0) {
    await setCache(cacheKey, count, CACHE_TTL.commits);
  }
  return count;
}

export async function getTreeCached(
  store: GitStore,
  ref: string,
  filepath: string
): Promise<TreeEntry[] | null> {
  const cacheKey = repoCache.treeKey(store.ownerId, store.repoName, ref, filepath);
  const cached = await getCached<TreeEntry[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const tree = await getTree(store.fs, store.dir, ref, filepath);
  if (tree) {
    await setCache(cacheKey, tree, CACHE_TTL.tree);
  }
  return tree;
}

export async function getFileCached(
  store: GitStore,
  ref: string,
  filepath: string
): Promise<{ content: string; oid: string } | null> {
  const cacheKey = repoCache.fileKey(store.ownerId, store.repoName, ref, filepath);
  const cached = await getCached<{ content: string; oid: string }>(cacheKey);
  if (cached) {
    return cached;
  }

  const file = await getFile(store.fs, store.dir, ref, filepath);
  if (file && file.content.length <= MAX_FILE_CACHE_BYTES) {
    await setCache(cacheKey, file, CACHE_TTL.file);
  }
  return file;
}

export interface BranchComparison {
  commits: CommitInfo[];
  files: FileDiff[];
  stats: {
    additions: number;
    deletions: number;
    filesChanged: number;
    truncatedFiles?: number;
  };
  ahead: number;
  behind: number;
  mergeBaseOid: string | null;
}

async function getCommitOidsUpTo(
  fs: S3Fs,
  dir: string,
  startOid: string,
  stopOid: string | null,
  maxCommits: number = 1000
): Promise<string[]> {
  const oids: string[] = [];
  let currentOid: string | null = startOid;
  const seen = new Set<string>();

  while (currentOid && oids.length < maxCommits) {
    if (seen.has(currentOid) || currentOid === stopOid) {
      break;
    }
    seen.add(currentOid);
    oids.push(currentOid);

    try {
      const { commit } = await git.readCommit({ fs, dir, oid: currentOid });
      currentOid = commit.parent.length > 0 ? commit.parent[0] : null;
    } catch {
      break;
    }
  }

  return oids;
}

async function findMergeBase(
  fs: S3Fs,
  dir: string,
  oid1: string,
  oid2: string
): Promise<string | null> {
  const ancestors1 = new Set<string>();
  let current: string | null = oid1;
  
  while (current) {
    ancestors1.add(current);
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: current });
      current = commit.parent.length > 0 ? commit.parent[0] : null;
    } catch {
      break;
    }
    if (ancestors1.size > 10000) break;
  }

  current = oid2;
  while (current) {
    if (ancestors1.has(current)) {
      return current;
    }
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: current });
      current = commit.parent.length > 0 ? commit.parent[0] : null;
    } catch {
      break;
    }
  }

  return null;
}

export async function getMergeBase(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string
): Promise<string | null> {
  try {
    const baseExists = await refExists(baseStore.fs, baseStore.dir, baseBranch);
    const headExists = await refExists(headStore.fs, headStore.dir, headBranch);

    if (!baseExists || !headExists) {
      return null;
    }

    const baseOid = await git.resolveRef({ fs: baseStore.fs, dir: baseStore.dir, ref: normalizeRef(baseBranch) });
    const headOid = await git.resolveRef({ fs: headStore.fs, dir: headStore.dir, ref: normalizeRef(headBranch) });

    if (baseStore.ownerId === headStore.ownerId && baseStore.repoName === headStore.repoName) {
      return findMergeBase(baseStore.fs, baseStore.dir, baseOid, headOid);
    }

    return findMergeBase(headStore.fs, headStore.dir, headOid, baseOid);
  } catch (error) {
    console.error("[Git] getMergeBase error:", error);
    return null;
  }
}

export async function compareBranches(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string
): Promise<BranchComparison | null> {
  try {
    const baseExists = await refExists(baseStore.fs, baseStore.dir, baseBranch);
    const headExists = await refExists(headStore.fs, headStore.dir, headBranch);

    if (!baseExists || !headExists) {
      return null;
    }

    const baseOid = await git.resolveRef({ fs: baseStore.fs, dir: baseStore.dir, ref: normalizeRef(baseBranch) });
    const headOid = await git.resolveRef({ fs: headStore.fs, dir: headStore.dir, ref: normalizeRef(headBranch) });

    const mergeBaseOid = await getMergeBase(baseStore, baseBranch, headStore, headBranch);

    const headCommitOids = mergeBaseOid
      ? await getCommitOidsUpTo(headStore.fs, headStore.dir, headOid, mergeBaseOid)
      : await getCommitOidsUpTo(headStore.fs, headStore.dir, headOid, null, 100);

    const baseCommitOids = mergeBaseOid
      ? await getCommitOidsUpTo(baseStore.fs, baseStore.dir, baseOid, mergeBaseOid)
      : [];

    const commits: CommitInfo[] = [];
    for (const oid of headCommitOids) {
      try {
        const { commit } = await git.readCommit({ fs: headStore.fs, dir: headStore.dir, oid });
        commits.push({
          oid,
          message: commit.message,
          author: {
            name: commit.author.name,
            email: commit.author.email,
          },
          timestamp: commit.author.timestamp * 1000,
        });
      } catch {
        continue;
      }
    }

    let files: FileDiff[] = [];
    let stats = { additions: 0, deletions: 0, filesChanged: 0 };

    if (mergeBaseOid) {
      const baseTreeOid = await getTreeOidForCommit(baseStore.fs, baseStore.dir, mergeBaseOid);
      const headTreeOid = await getTreeOidForCommit(headStore.fs, headStore.dir, headOid);

      if (baseTreeOid && headTreeOid) {
        const changedFiles = await compareTreesRecursive(
          headStore.fs,
          headStore.dir,
          baseTreeOid,
          headTreeOid,
          ""
        );

        const processed = await processChangedFiles(headStore.fs, headStore.dir, changedFiles);
        files = processed.files;
        stats = processed.stats;
      }
    } else if (headCommitOids.length > 0) {
      const diff = await getCommitDiff(headStore.fs, headStore.dir, headOid);
      if (diff) {
        files = diff.files;
        stats = diff.stats;
      }
    }

    return {
      commits,
      files,
      stats,
      ahead: headCommitOids.length,
      behind: baseCommitOids.length,
      mergeBaseOid,
    };
  } catch (error) {
    console.error("[Git] compareBranches error:", error);
    return null;
  }
}

async function getTreeOidForCommit(fs: S3Fs, dir: string, oid: string): Promise<string | null> {
  try {
    const { commit } = await git.readCommit({ fs, dir, oid });
    return commit.tree;
  } catch {
    return null;
  }
}

export async function canMerge(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string
): Promise<{ canMerge: boolean; conflictFiles?: string[] }> {
  try {
    const comparison = await compareBranches(baseStore, baseBranch, headStore, headBranch);
    
    if (!comparison) {
      return { canMerge: false, conflictFiles: [] };
    }

    if (comparison.ahead === 0) {
      return { canMerge: false, conflictFiles: [] };
    }

    return { canMerge: true };
  } catch (error) {
    console.error("[Git] canMerge error:", error);
    return { canMerge: false, conflictFiles: [] };
  }
}

async function copyGitObject(
  sourceStore: GitStore,
  targetStore: GitStore,
  oid: string,
  type: "blob" | "tree" | "commit"
): Promise<boolean> {
  try {
    const prefix = oid.substring(0, 2);
    const suffix = oid.substring(2);
    const objectPath = `.git/objects/${prefix}/${suffix}`;

    try {
      await targetStore.fs.promises.stat(objectPath);
      return true;
    } catch {
    }

    const data = await sourceStore.fs.promises.readFile(objectPath);
    
    const dirPath = `.git/objects/${prefix}`;
    try {
      await targetStore.fs.promises.mkdir(dirPath);
    } catch {
    }

    await targetStore.fs.promises.writeFile(objectPath, data);
    return true;
  } catch (error) {
    console.error(`[Git] copyGitObject error for ${oid}:`, error);
    return false;
  }
}

async function copyTreeRecursive(
  sourceStore: GitStore,
  targetStore: GitStore,
  treeOid: string
): Promise<boolean> {
  try {
    if (!await copyGitObject(sourceStore, targetStore, treeOid, "tree")) {
      return false;
    }

    const tree = await git.readTree({ fs: sourceStore.fs, dir: sourceStore.dir, oid: treeOid });
    
    for (const entry of tree.tree) {
      if (entry.type === "blob") {
        await copyGitObject(sourceStore, targetStore, entry.oid, "blob");
      } else if (entry.type === "tree") {
        await copyTreeRecursive(sourceStore, targetStore, entry.oid);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`[Git] copyTreeRecursive error for ${treeOid}:`, error);
    return false;
  }
}

async function copyCommitAndAncestors(
  sourceStore: GitStore,
  targetStore: GitStore,
  commitOid: string,
  stopAtOid: string | null,
  maxDepth: number = 100
): Promise<boolean> {
  try {
    const visited = new Set<string>();
    const toProcess = [commitOid];
    let depth = 0;

    while (toProcess.length > 0 && depth < maxDepth) {
      const oid = toProcess.shift()!;
      
      if (visited.has(oid) || oid === stopAtOid) {
        continue;
      }
      visited.add(oid);

      await copyGitObject(sourceStore, targetStore, oid, "commit");
      
      const { commit } = await git.readCommit({ fs: sourceStore.fs, dir: sourceStore.dir, oid });
      
      await copyTreeRecursive(sourceStore, targetStore, commit.tree);
      
      for (const parentOid of commit.parent) {
        if (!visited.has(parentOid) && parentOid !== stopAtOid) {
          toProcess.push(parentOid);
        }
      }
      
      depth++;
    }
    
    return true;
  } catch (error) {
    console.error(`[Git] copyCommitAndAncestors error:`, error);
    return false;
  }
}

export async function performMerge(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string,
  mergeMessage: string,
  authorName: string,
  authorEmail: string
): Promise<{ mergeCommitOid: string } | null> {
  try {
    console.log(`[Git] performMerge starting: base=${baseBranch}, head=${headBranch}`);
    console.log(`[Git] baseStore: owner=${baseStore.ownerId}, repo=${baseStore.repoName}`);
    console.log(`[Git] headStore: owner=${headStore.ownerId}, repo=${headStore.repoName}`);
    
    const baseOid = await git.resolveRef({ 
      fs: baseStore.fs, 
      dir: baseStore.dir, 
      ref: normalizeRef(baseBranch) 
    });
    console.log(`[Git] Base OID: ${baseOid}`);
    
    const headOid = await git.resolveRef({ 
      fs: headStore.fs, 
      dir: headStore.dir, 
      ref: normalizeRef(headBranch) 
    });
    console.log(`[Git] Head OID: ${headOid}`);

    const isCrossRepo = baseStore.ownerId !== headStore.ownerId || baseStore.repoName !== headStore.repoName;
    console.log(`[Git] Is cross-repo merge: ${isCrossRepo}`);
    
    if (isCrossRepo) {
      const mergeBase = await findMergeBase(headStore.fs, headStore.dir, headOid, baseOid);
      console.log(`[Git] Merge base for cross-repo: ${mergeBase}`);
      
      const copied = await copyCommitAndAncestors(headStore, baseStore, headOid, mergeBase);
      if (!copied) {
        console.error("[Git] Failed to copy git objects for cross-repo merge");
        return null;
      }
      console.log("[Git] Successfully copied git objects for cross-repo merge");
    }

    const { commit: headCommit } = await git.readCommit({ 
      fs: isCrossRepo ? baseStore.fs : headStore.fs, 
      dir: isCrossRepo ? baseStore.dir : headStore.dir, 
      oid: headOid 
    });
    const headTreeOid = headCommit.tree;
    console.log(`[Git] Head tree OID: ${headTreeOid}`);

    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();

    console.log(`[Git] Creating merge commit with parents: [${baseOid}, ${headOid}]`);
    const mergeCommitOid = await git.writeCommit({
      fs: baseStore.fs,
      dir: baseStore.dir,
      commit: {
        message: mergeMessage,
        tree: headTreeOid,
        parent: [baseOid, headOid],
        author: {
          name: authorName,
          email: authorEmail,
          timestamp,
          timezoneOffset,
        },
        committer: {
          name: authorName,
          email: authorEmail,
          timestamp,
          timezoneOffset,
        },
      },
    });
    console.log(`[Git] Merge commit created: ${mergeCommitOid}`);

    const refPath = `.git/refs/heads/${baseBranch}`;
    console.log(`[Git] Updating ref at: ${refPath}`);
    await baseStore.fs.promises.writeFile(refPath, mergeCommitOid + "\n");
    console.log(`[Git] Ref updated successfully`);
    
    const verifyOid = await git.resolveRef({
      fs: baseStore.fs,
      dir: baseStore.dir,
      ref: normalizeRef(baseBranch)
    });
    console.log(`[Git] Verified ref now points to: ${verifyOid}`);
    
    if (verifyOid !== mergeCommitOid) {
      console.error(`[Git] WARNING: Ref verification failed! Expected ${mergeCommitOid} but got ${verifyOid}`);
    }

    return { mergeCommitOid };
  } catch (error) {
    console.error("[Git] performMerge error:", error);
    return null;
  }
}

// ─── Branch management ───────────────────────────────────────────────────────

export async function createBranch(
  fs: S3Fs,
  dir: string,
  newBranch: string,
  fromRef: string
): Promise<{ oid: string } | null> {
  try {
    const fromOid = await git.resolveRef({ fs, dir, ref: normalizeRef(fromRef) });
    const refPath = `refs/heads/${newBranch}`;
    await fs.promises.writeFile(refPath, fromOid + "\n");
    return { oid: fromOid };
  } catch (error) {
    console.error("[Git] createBranch error:", error);
    return null;
  }
}

export async function deleteBranch(fs: S3Fs, dir: string, branch: string): Promise<boolean> {
  try {
    const refPath = `refs/heads/${branch}`;
    await fs.promises.unlink(refPath);
    return true;
  } catch (error) {
    console.error("[Git] deleteBranch error:", error);
    return false;
  }
}

// ─── Web-based file editing ──────────────────────────────────────────────────

export async function commitFile(
  store: GitStore,
  branch: string,
  filePath: string,
  content: string,
  message: string,
  authorName: string,
  authorEmail: string,
  deleteFile = false
): Promise<{ commitOid: string } | null> {
  try {
    const { fs, dir } = store;
    const headOid = await git.resolveRef({ fs, dir, ref: normalizeRef(branch) });
    const { commit: headCommit } = await git.readCommit({ fs, dir, oid: headOid });

    // Traverse the existing tree, building a mutable map at each directory level
    const parts = filePath.split("/").filter(Boolean);
    const filename = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    // Read trees from root to parent directory
    type TreeMap = Map<string, { mode: string; type: string; oid: string }>;
    const treeMaps: TreeMap[] = [];
    let currentTreeOid = headCommit.tree;

    for (const part of dirParts) {
      const rawTree = await git.readTree({ fs, dir, oid: currentTreeOid });
      const treeMap: TreeMap = new Map(rawTree.tree.map((e) => [e.path, { mode: e.mode, type: e.type, oid: e.oid }]));
      treeMaps.push(treeMap);
      const entry = treeMap.get(part);
      if (!entry || entry.type !== "tree") {
        if (deleteFile) return null; // Nothing to delete
        // Create empty tree for new directory
        currentTreeOid = await git.writeTree({ fs, dir, tree: [] });
        treeMap.set(part, { mode: "040000", type: "tree", oid: currentTreeOid });
      } else {
        currentTreeOid = entry.oid;
      }
    }

    // Write leaf tree (with or without the file)
    const leafRawTree = await git.readTree({ fs, dir, oid: currentTreeOid }).catch(() => ({ tree: [] }));
    const leafMap: TreeMap = new Map(leafRawTree.tree.map((e) => [e.path, { mode: e.mode, type: e.type, oid: e.oid }]));

    if (deleteFile) {
      if (!leafMap.has(filename)) return null;
      leafMap.delete(filename);
    } else {
      const encoder = new TextEncoder();
      const blobOid = await git.writeBlob({ fs, dir, blob: encoder.encode(content) });
      leafMap.set(filename, { mode: "100644", type: "blob", oid: blobOid });
    }

    // Write tree objects from leaf to root
    let newTreeOid = await git.writeTree({
      fs,
      dir,
      tree: Array.from(leafMap.entries()).map(([path, e]) => ({ path, mode: e.mode as any, oid: e.oid, type: e.type as any })),
    });

    for (let i = dirParts.length - 1; i >= 0; i--) {
      const parentMap = i === 0
        ? new Map<string, { mode: string; type: string; oid: string }>(
            (await git.readTree({ fs, dir, oid: headCommit.tree }).catch(() => ({ tree: [] }))).tree.map((e) => [
              e.path,
              { mode: e.mode, type: e.type, oid: e.oid },
            ])
          )
        : treeMaps[i - 1]!;
      parentMap.set(dirParts[i]!, { mode: "040000", type: "tree", oid: newTreeOid });
      newTreeOid = await git.writeTree({
        fs,
        dir,
        tree: Array.from(parentMap.entries()).map(([path, e]) => ({ path, mode: e.mode as any, oid: e.oid, type: e.type as any })),
      });
    }

    // If depth is 0 we need to re-read root tree when building root
    if (dirParts.length === 0) {
      newTreeOid = await git.writeTree({
        fs,
        dir,
        tree: Array.from(leafMap.entries()).map(([path, e]) => ({ path, mode: e.mode as any, oid: e.oid, type: e.type as any })),
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();

    const commitOid = await git.writeCommit({
      fs,
      dir,
      commit: {
        message,
        tree: newTreeOid,
        parent: [headOid],
        author: { name: authorName, email: authorEmail, timestamp, timezoneOffset },
        committer: { name: authorName, email: authorEmail, timestamp, timezoneOffset },
      },
    });

    await fs.promises.writeFile(`refs/heads/${branch}`, commitOid + "\n");
    return { commitOid };
  } catch (error) {
    console.error("[Git] commitFile error:", error);
    return null;
  }
}

// ─── Squash & Rebase merge ───────────────────────────────────────────────────

export async function squashMerge(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string
): Promise<{ mergeCommitOid: string } | null> {
  try {
    const { fs: bFs, dir: bDir } = baseStore;
    const { fs: hFs, dir: hDir } = headStore;

    const baseOid = await git.resolveRef({ fs: bFs, dir: bDir, ref: normalizeRef(baseBranch) });
    const headOid = await git.resolveRef({ fs: hFs, dir: hDir, ref: normalizeRef(headBranch) });

    const isCrossRepo = baseStore.ownerId !== headStore.ownerId || baseStore.repoName !== headStore.repoName;
    if (isCrossRepo) {
      const mergeBase = await findMergeBase(hFs, hDir, headOid, baseOid);
      const copied = await copyCommitAndAncestors(headStore, baseStore, headOid, mergeBase);
      if (!copied) return null;
    }

    const { commit: headCommit } = await git.readCommit({
      fs: isCrossRepo ? bFs : hFs,
      dir: isCrossRepo ? bDir : hDir,
      oid: headOid,
    });

    // Squash: single commit with the head tree, single parent = base
    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();

    const squashCommitOid = await git.writeCommit({
      fs: bFs,
      dir: bDir,
      commit: {
        message: commitMessage,
        tree: headCommit.tree,
        parent: [baseOid],
        author: { name: authorName, email: authorEmail, timestamp, timezoneOffset },
        committer: { name: authorName, email: authorEmail, timestamp, timezoneOffset },
      },
    });

    await bFs.promises.writeFile(`refs/heads/${baseBranch}`, squashCommitOid + "\n");
    return { mergeCommitOid: squashCommitOid };
  } catch (error) {
    console.error("[Git] squashMerge error:", error);
    return null;
  }
}

export async function rebaseMerge(
  baseStore: GitStore,
  baseBranch: string,
  headStore: GitStore,
  headBranch: string,
  authorName: string,
  authorEmail: string
): Promise<{ mergeCommitOid: string } | null> {
  try {
    const { fs: bFs, dir: bDir } = baseStore;
    const { fs: hFs, dir: hDir } = headStore;

    const baseOid = await git.resolveRef({ fs: bFs, dir: bDir, ref: normalizeRef(baseBranch) });
    const headOid = await git.resolveRef({ fs: hFs, dir: hDir, ref: normalizeRef(headBranch) });

    const isCrossRepo = baseStore.ownerId !== headStore.ownerId || baseStore.repoName !== headStore.repoName;
    if (isCrossRepo) {
      const mergeBase = await findMergeBase(hFs, hDir, headOid, baseOid);
      const copied = await copyCommitAndAncestors(headStore, baseStore, headOid, mergeBase);
      if (!copied) return null;
    }

    // Fast-forward rebase: move base branch tip to head's tip
    const { commit: headCommit } = await git.readCommit({
      fs: isCrossRepo ? bFs : hFs,
      dir: isCrossRepo ? bDir : hDir,
      oid: headOid,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const timezoneOffset = new Date().getTimezoneOffset();

    // Create a new commit on top of base
    const rebaseCommitOid = await git.writeCommit({
      fs: bFs,
      dir: bDir,
      commit: {
        message: headCommit.message,
        tree: headCommit.tree,
        parent: [baseOid],
        author: headCommit.author,
        committer: { name: authorName, email: authorEmail, timestamp, timezoneOffset },
      },
    });

    await bFs.promises.writeFile(`refs/heads/${baseBranch}`, rebaseCommitOid + "\n");
    return { mergeCommitOid: rebaseCommitOid };
  } catch (error) {
    console.error("[Git] rebaseMerge error:", error);
    return null;
  }
}

// ─── Tag management ──────────────────────────────────────────────────────────

export interface TagInfo {
  name: string;
  oid: string;
  message?: string;
  taggerName?: string;
  taggerEmail?: string;
  timestamp?: number;
  targetOid: string;
}

export async function listTags(fs: S3Fs, dir: string): Promise<TagInfo[]> {
  try {
    const tags = await git.listTags({ fs, dir });
    const result: TagInfo[] = [];
    for (const name of tags) {
      try {
        const tagOid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
        const object = await git.readObject({ fs, dir, oid: tagOid });
        if (object.type === "tag") {
          const tag = object.object as any;
          result.push({
            name,
            oid: tagOid,
            message: tag.message,
            taggerName: tag.tagger?.name,
            taggerEmail: tag.tagger?.email,
            timestamp: tag.tagger?.timestamp ? tag.tagger.timestamp * 1000 : undefined,
            targetOid: tag.object,
          });
        } else {
          result.push({ name, oid: tagOid, targetOid: tagOid });
        }
      } catch {
        // skip malformed tags
      }
    }
    return result;
  } catch (error) {
    console.error("[Git] listTags error:", error);
    return [];
  }
}

export async function createTag(
  fs: S3Fs,
  dir: string,
  name: string,
  targetRef: string,
  message?: string,
  taggerName?: string,
  taggerEmail?: string
): Promise<{ oid: string } | null> {
  try {
    const targetOid = await git.resolveRef({ fs, dir, ref: normalizeRef(targetRef) });

    if (message && taggerName && taggerEmail) {
      // Annotated tag
      const timestamp = Math.floor(Date.now() / 1000);
      const timezoneOffset = new Date().getTimezoneOffset();
      const tagOid = await git.writeTag({
        fs,
        dir,
        tag: {
          object: targetOid,
          type: "commit",
          tag: name,
          tagger: { name: taggerName, email: taggerEmail, timestamp, timezoneOffset },
          message,
        },
      });
      await fs.promises.writeFile(`refs/tags/${name}`, tagOid + "\n");
      return { oid: tagOid };
    } else {
      // Lightweight tag
      await fs.promises.writeFile(`refs/tags/${name}`, targetOid + "\n");
      return { oid: targetOid };
    }
  } catch (error) {
    console.error("[Git] createTag error:", error);
    return null;
  }
}

export async function deleteTag(fs: S3Fs, dir: string, name: string): Promise<boolean> {
  try {
    await fs.promises.unlink(`refs/tags/${name}`);
    return true;
  } catch (error) {
    console.error("[Git] deleteTag error:", error);
    return false;
  }
}

export { repoCache };
