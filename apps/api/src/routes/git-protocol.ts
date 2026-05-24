import { Hono } from "hono";
import { db, users, repositoryCollaborators } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { type AuthUser, type AuthVariables } from "../middleware/auth";
import { getRefsAdvertisement, repoCache } from "../git";
import { resolveRepositoryBySlug, createRepoGitStore } from "../lib/repo-helpers";
import git from "isomorphic-git";
import { getAuth } from "../auth";
import { putObject, deleteObject, getObject } from "../s3";
import { createHash } from "crypto";
import { deflate, inflate, inflateWithConsumedBytes } from "../lib/async-zlib";
import { GIT_MAX_OBJECTS_PER_PUSH, GIT_MAX_DELTA_DEPTH, forceGCIfNeeded, measureMemory } from "../middleware/limits";
import { triggerWorkflows } from "../workflows/trigger";
import { syncWorkflows } from "../workflows/sync";

const app = new Hono<{ Variables: AuthVariables }>();

async function resolveBasicAuthUser(authHeader: string | undefined): Promise<AuthUser | null> {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  const token = authHeader.slice("Basic ".length).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const identifier = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  if (!identifier || !password) {
    return null;
  }

  const auth = getAuth();

  try {
    const tokenResult: any = await (auth.api as any).verifyApiKey({
      body: { key: password },
      headers: new Headers(),
    });

    if (tokenResult?.valid && tokenResult?.key?.userId) {
      const tokenUserRow = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          username: users.username,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.id, tokenResult.key.userId))
        .limit(1);

      const tokenUser = tokenUserRow[0];
      if (tokenUser) {
        const identifierMatches = identifier.includes("@")
          ? tokenUser.email.toLowerCase() === identifier.toLowerCase()
          : tokenUser.username.toLowerCase() === identifier.toLowerCase();

        if (identifierMatches) {
          return {
            id: tokenUser.id,
            name: tokenUser.name,
            email: tokenUser.email,
            username: tokenUser.username,
            avatarUrl: tokenUser.avatarUrl,
          };
        }
      }
    }
  } catch {
    // Fall back to password auth when token verification fails.
  }

  let email = identifier;
  if (!identifier.includes("@")) {
    const userRow = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        username: users.username,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.username, identifier))
      .limit(1);

    if (!userRow[0]) {
      return null;
    }

    email = userRow[0].email;
  }

  try {
    const result: any = await auth.api.signInEmail({
      body: {
        email,
        password,
        rememberMe: false,
      },
      headers: new Headers(),
    });
    const user = result?.user ?? result?.session?.user ?? null;
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      avatarUrl: user.image ?? null,
    };
  } catch {
    return null;
  }
}

async function resolveGitUser(c: { get: (key: string) => AuthUser | undefined; req: { header: (name: string) => string | undefined } }): Promise<AuthUser | null> {
  const currentUser = c.get("user");
  if (currentUser) {
    return currentUser;
  }
  return await resolveBasicAuthUser(c.req.header("authorization"));
}

async function canReadRepository(repo: { id: string; ownerId: string; organizationId?: string | null; visibility: string }, currentUser: AuthUser | null): Promise<boolean> {
  // Admins always have read access (but need valid id)
  if (currentUser?.role === "admin" && currentUser?.id) {
    return true;
  }
  if (repo.visibility === "public") {
    return true;
  }
  if (!currentUser?.id) {
    return false;
  }
  if (currentUser.id === repo.ownerId) {
    return true;
  }

  const collaborator = await db.query.repositoryCollaborators.findFirst({
    where: and(eq(repositoryCollaborators.repositoryId, repo.id), eq(repositoryCollaborators.userId, currentUser.id)),
  });
  return Boolean(collaborator);
}

async function canWriteRepository(repo: { id: string; ownerId: string }, currentUser: AuthUser | null): Promise<boolean> {
  if (!currentUser?.id) {
    return false;
  }
  // Admins need explicit collaborator write access (not bypassed)
  if (currentUser.id === repo.ownerId) {
    return true;
  }

  const collaborator = await db.query.repositoryCollaborators.findFirst({
    where: and(eq(repositoryCollaborators.repositoryId, repo.id), eq(repositoryCollaborators.userId, currentUser.id)),
  });

  return collaborator?.permission === "write" || collaborator?.permission === "admin";
}

function unauthorizedBasic(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="sigmagit"',
    },
  });
}

app.get("/:owner/:name/info/refs", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const service = c.req.query("service");
  const currentUser = await resolveGitUser(c);

  if (!service || (service !== "git-upload-pack" && service !== "git-receive-pack")) {
    return c.json({ error: "Invalid service" }, 404);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (service === "git-receive-pack") {
    if (!(await canWriteRepository(repo, currentUser))) {
      return unauthorizedBasic();
    }
  } else {
    if (!(await canReadRepository(repo, currentUser))) {
      return unauthorizedBasic();
    }
  }

  const refs = await getRefsAdvertisement(store.fs, store.dir, service);

  const packet = `# service=${service}\n`;
  const packetLen = (packet.length + 4).toString(16).padStart(4, "0");

  const response = Buffer.concat([
    Buffer.from(packetLen),
    Buffer.from(packet),
    Buffer.from("0000"),
    refs,
  ]);

  return new Response(response, {
    status: 200,
    headers: {
      "Content-Type": `application/x-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
});

app.post("/:owner/:name/git-upload-pack", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = await resolveGitUser(c);

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canReadRepository(repo, currentUser))) {
    return unauthorizedBasic();
  }

  try {
    const body = await c.req.arrayBuffer();
    const requestData = Buffer.from(body);
    const uploadRequest = parseUploadPackRequest(requestData);

    if (uploadRequest.wants.length === 0) {
      return new Response("0008NAK\n", {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-upload-pack-result",
          "Cache-Control": "no-cache",
        },
      });
    }

    const objects = await collectReachableObjects(store.fs, store.dir, uploadRequest.wants);
    const pack = await buildPackFile(objects);
    const response = Buffer.concat([Buffer.from("0008NAK\n", "ascii"), pack]);

    return new Response(response, {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("[API] upload-pack error:", error);
    return new Response("0008NAK\n", {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  }
});

function parsePktLines(data: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;

  while (offset < data.length) {
    if (offset + 4 > data.length) break;

    const lenHex = data.slice(offset, offset + 4).toString("utf8");
    const len = parseInt(lenHex, 16);

    if (len === 0) break;
    if (len < 4) break;

    const contentLen = len - 4;
    if (offset + len > data.length) break;

    const content = data.slice(offset + 4, offset + len).toString("utf8");
    if (content.length > 0) {
      lines.push(content);
    }

    offset += len;
  }

  return lines;
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

interface PackObject {
  type: number;
  data: Buffer;
  offset: number;
  baseOid?: string;
  baseOffset?: number;
}

interface UploadPackRequest {
  wants: string[];
  haves: string[];
  done: boolean;
  capabilities: Set<string>;
}

interface UploadObject {
  oid: string;
  type: "commit" | "tree" | "blob" | "tag";
  data: Buffer;
}

function readPackVarInt(buf: Buffer, offset: number): { value: number; type: number; bytesRead: number } {
  let byte = buf[offset];
  const type = (byte >> 4) & 0x7;
  let value = byte & 0x0f;
  let shift = 4;
  let bytesRead = 1;

  while (byte & 0x80) {
    byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    bytesRead++;
  }

  return { value, type, bytesRead };
}

function readOfsOffset(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let byte = buf[offset];
  let value = byte & 0x7f;
  let bytesRead = 1;

  while (byte & 0x80) {
    byte = buf[offset + bytesRead];
    value = ((value + 1) << 7) | (byte & 0x7f);
    bytesRead++;
  }

  return { value, bytesRead };
}

function parsePktLinesAll(data: Buffer): Array<string | null> {
  const lines: Array<string | null> = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const lenHex = data.slice(offset, offset + 4).toString("utf8");
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      break;
    }

    const len = parseInt(lenHex, 16);
    if (len === 0) {
      lines.push(null);
      offset += 4;
      continue;
    }

    if (len < 4 || offset + len > data.length) {
      break;
    }

    const content = data.slice(offset + 4, offset + len).toString("utf8");
    lines.push(content);
    offset += len;
  }

  return lines;
}

function parseUploadPackRequest(data: Buffer): UploadPackRequest {
  const packets = parsePktLinesAll(data);
  const wants: string[] = [];
  const haves: string[] = [];
  const capabilities = new Set<string>();
  let done = false;
  let firstWant = true;

  for (const packet of packets) {
    if (packet === null) {
      continue;
    }

    const line = packet.trim();
    if (!line) {
      continue;
    }

    if (line === "done") {
      done = true;
      continue;
    }

    if (line.startsWith("want ")) {
      const parts = line.split(/\s+/);
      const oid = parts[1];
      if (oid && /^[0-9a-f]{40}$/i.test(oid)) {
        wants.push(oid);
      }

      if (firstWant && parts.length > 2) {
        for (let i = 2; i < parts.length; i++) {
          capabilities.add(parts[i]);
        }
      }
      firstWant = false;
      continue;
    }

    if (line.startsWith("have ")) {
      const parts = line.split(/\s+/);
      const oid = parts[1];
      if (oid && /^[0-9a-f]{40}$/i.test(oid)) {
        haves.push(oid);
      }
    }
  }

  return {
    wants: [...new Set(wants)],
    haves: [...new Set(haves)],
    done,
    capabilities,
  };
}

function toObjectBuffer(object: unknown): Buffer {
  if (Buffer.isBuffer(object)) {
    return object;
  }
  if (object instanceof Uint8Array) {
    return Buffer.from(object);
  }
  if (typeof object === "string") {
    return Buffer.from(object, "utf8");
  }
  return Buffer.from([]);
}

async function collectReachableObjects(fs: any, dir: string, startOids: string[]): Promise<UploadObject[]> {
  const queued = new Set<string>(startOids);
  const stack = [...startOids];
  const visited = new Set<string>();
  const objects: UploadObject[] = [];

  const enqueue = (oid: string | undefined) => {
    if (!oid || !/^[0-9a-f]{40}$/i.test(oid)) {
      return;
    }
    if (visited.has(oid) || queued.has(oid)) {
      return;
    }
    queued.add(oid);
    stack.push(oid);
  };

  while (stack.length > 0) {
    const oid = stack.pop()!;
    queued.delete(oid);

    if (visited.has(oid)) {
      continue;
    }
    visited.add(oid);

    let objectType: "commit" | "tree" | "blob" | "tag";
    let objectData: Buffer;

    try {
      const read = await git.readObject({ fs, dir, oid, format: "content" });
      if (read.type !== "commit" && read.type !== "tree" && read.type !== "blob" && read.type !== "tag") {
        continue;
      }
      objectType = read.type;
      objectData = toObjectBuffer(read.object);
      objects.push({ oid, type: objectType, data: objectData });
    } catch {
      continue;
    }

    try {
      if (objectType === "commit") {
        const { commit } = await git.readCommit({ fs, dir, oid });
        enqueue(commit.tree);
        for (const parent of commit.parent) {
          enqueue(parent);
        }
      } else if (objectType === "tree") {
        const { tree } = await git.readTree({ fs, dir, oid });
        for (const entry of tree) {
          enqueue(entry.oid);
        }
      } else if (objectType === "tag") {
        const { tag } = await git.readTag({ fs, dir, oid });
        enqueue(tag.object);
      }
    } catch {
      continue;
    }
  }

  return objects;
}

function encodePackObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];

  let first = ((type & 0x7) << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) {
    first |= 0x80;
  }
  bytes.push(first);

  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) {
      next |= 0x80;
    }
    bytes.push(next);
  }

  return Buffer.from(bytes);
}

async function buildPackFile(objects: UploadObject[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const typeMap: Record<UploadObject["type"], number> = {
    commit: OBJ_COMMIT,
    tree: OBJ_TREE,
    blob: OBJ_BLOB,
    tag: OBJ_TAG,
  };

  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);

  const objectChunks = await Promise.all(
    objects.map(async (object) => {
      const type = typeMap[object.type];
      const objectHeader = encodePackObjectHeader(type, object.data.length);
      const compressed = await deflate(object.data);
      return [objectHeader, compressed] as const;
    })
  );

  for (const [objectHeader, compressed] of objectChunks) {
    chunks.push(objectHeader, compressed);
  }

  const packWithoutTrailer = Buffer.concat(chunks);
  const trailer = createHash("sha1").update(packWithoutTrailer).digest();
  return Buffer.concat([packWithoutTrailer, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;

  let baseSize = 0;
  let shift = 0;
  while (offset < delta.length) {
    const byte = delta[offset++];
    baseSize |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  let resultSize = 0;
  shift = 0;
  while (offset < delta.length) {
    const byte = delta[offset++];
    resultSize |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }

  const result: Buffer[] = [];
  let resultLen = 0;

  while (offset < delta.length) {
    const cmd = delta[offset++];

    if (cmd & 0x80) {
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset = delta[offset++];
      if (cmd & 0x02) copyOffset |= delta[offset++] << 8;
      if (cmd & 0x04) copyOffset |= delta[offset++] << 16;
      if (cmd & 0x08) copyOffset |= delta[offset++] << 24;

      if (cmd & 0x10) copySize = delta[offset++];
      if (cmd & 0x20) copySize |= delta[offset++] << 8;
      if (cmd & 0x40) copySize |= delta[offset++] << 16;

      if (copySize === 0) copySize = 0x10000;

      result.push(base.subarray(copyOffset, copyOffset + copySize));
      resultLen += copySize;
    } else if (cmd > 0) {
      result.push(delta.subarray(offset, offset + cmd));
      offset += cmd;
      resultLen += cmd;
    }
  }

  return Buffer.concat(result);
}

function typeToString(type: number): string {
  switch (type) {
    case OBJ_COMMIT: return "commit";
    case OBJ_TREE: return "tree";
    case OBJ_BLOB: return "blob";
    case OBJ_TAG: return "tag";
    default: return "unknown";
  }
}

function hashObject(type: string, data: Buffer): string {
  const header = `${type} ${data.length}\0`;
  const store = Buffer.concat([Buffer.from(header), data]);
  return createHash("sha1").update(store).digest("hex");
}

async function loadObjectFromStorage(baseOid: string, basePath: string): Promise<{ type: number; data: Buffer } | null> {
  try {
    const prefix = baseOid.substring(0, 2);
    const suffix = baseOid.substring(2);
    const objectPath = `${basePath}/objects/${prefix}/${suffix}`;

    const compressed = await getObject(objectPath);
    if (!compressed) {
      return null;
    }

    const decompressed = await inflate(compressed);
    const nullIndex = decompressed.indexOf(0);
    if (nullIndex === -1) {
      return null;
    }

    const header = decompressed.subarray(0, nullIndex).toString("utf8");
    const parts = header.split(" ");
    if (parts.length !== 2) {
      return null;
    }

    const typeStr = parts[0];
    let type = 0;
    if (typeStr === "commit") type = OBJ_COMMIT;
    else if (typeStr === "tree") type = OBJ_TREE;
    else if (typeStr === "blob") type = OBJ_BLOB;
    else if (typeStr === "tag") type = OBJ_TAG;
    else return null;

    const data = decompressed.subarray(nullIndex + 1);
    return { type, data };
  } catch (error) {
    console.error(`[API] Failed to load object ${baseOid} from storage:`, error);
    return null;
  }
}

async function unpackPackFile(
  packData: Buffer,
  storeObject: (oid: string, type: string, data: Buffer) => Promise<void>,
  basePath: string
): Promise<{ success: boolean; objectCount: number; error?: string }> {
  try {
    if (packData.length < 12) {
      return { success: false, objectCount: 0, error: "Pack file too small" };
    }

    const signature = packData.subarray(0, 4).toString("ascii");
    if (signature !== "PACK") {
      return { success: false, objectCount: 0, error: "Invalid pack signature" };
    }

    const version = packData.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      return { success: false, objectCount: 0, error: `Unsupported pack version: ${version}` };
    }

    const numObjects = packData.readUInt32BE(8);

    if (numObjects > GIT_MAX_OBJECTS_PER_PUSH) {
      return { success: false, objectCount: 0, error: `Too many objects: ${numObjects} (max: ${GIT_MAX_OBJECTS_PER_PUSH})` };
    }

    const objects: Map<number, PackObject> = new Map();
    const refDeltas: Array<{ obj: PackObject; baseOid: string }> = [];
    let offset = 12;

    for (let i = 0; i < numObjects; i++) {
      const objOffset = offset;
      const header = readPackVarInt(packData, offset);
      offset += header.bytesRead;

      const obj: PackObject = {
        type: header.type,
        data: Buffer.alloc(0),
        offset: objOffset,
      };

      if (header.type === OBJ_OFS_DELTA) {
        const ofs = readOfsOffset(packData, offset);
        offset += ofs.bytesRead;
        obj.baseOffset = objOffset - ofs.value;
      } else if (header.type === OBJ_REF_DELTA) {
        obj.baseOid = packData.subarray(offset, offset + 20).toString("hex");
        offset += 20;
        refDeltas.push({ obj, baseOid: obj.baseOid });
      }

      const inflated = await inflateWithConsumedBytes(packData, offset);
      obj.data = inflated.data;
      offset += inflated.bytesRead;
      objects.set(objOffset, obj);

      if (i % 1000 === 0) {
        console.log(`[API] unpack: processed ${i}/${numObjects} objects`);
        forceGCIfNeeded();
      }
    }

    const baseObjects = new Map<string, { type: number; data: Buffer }>();

    if (refDeltas.length > 0) {
      console.log(`[API] unpack: loading ${refDeltas.length} REF_DELTA base objects from storage`);
      const uniqueBaseOids = [...new Set(refDeltas.map(d => d.baseOid))];
      console.log(`[API] unpack: ${uniqueBaseOids.length} unique base objects to load`);

      const LOAD_BATCH_SIZE = 20;
      for (let i = 0; i < uniqueBaseOids.length; i += LOAD_BATCH_SIZE) {
        const batch = uniqueBaseOids.slice(i, i + LOAD_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (baseOid) => {
            const baseObj = await loadObjectFromStorage(baseOid, basePath);
            return { baseOid, baseObj };
          })
        );

        for (const { baseOid, baseObj } of results) {
          if (baseObj) {
            baseObjects.set(baseOid, baseObj);
          } else {
            console.warn(`[API] unpack: REF_DELTA base object ${baseOid} not found in storage`);
          }
        }
      }
      console.log(`[API] unpack: loaded ${baseObjects.size} base objects`);
    }

    const resolveDelta = (obj: PackObject, depth: number = 0): { type: number; data: Buffer } | null => {
      if (obj.type !== OBJ_OFS_DELTA && obj.type !== OBJ_REF_DELTA) {
        return { type: obj.type, data: obj.data };
      }

      if (depth > GIT_MAX_DELTA_DEPTH) {
        console.error(`[API] unpack: delta chain too deep (${depth}) for object at offset ${obj.offset}`);
        return null;
      }

      let base: PackObject | undefined;
      let baseData: { type: number; data: Buffer } | null = null;

      if (obj.baseOffset !== undefined) {
        base = objects.get(obj.baseOffset);
        if (base) {
          baseData = resolveDelta(base, depth + 1);
        }
      } else if (obj.baseOid) {
        baseData = baseObjects.get(obj.baseOid) || null;
      }

      if (!baseData) {
        return null;
      }

      const resolvedData = applyDelta(baseData.data, obj.data);
      return { type: baseData.type, data: resolvedData };
    };

    const objectsToStore: Array<{ oid: string; type: string; data: Buffer }> = [];
    let failed = 0;

    for (const [objOffset, obj] of objects) {
      const resolved = resolveDelta(obj);
      if (!resolved) {
        failed++;
        if (failed <= 10) {
          console.error(`[API] unpack: failed to resolve delta for object at offset ${objOffset}, type=${obj.type}`);
        }
        continue;
      }

      const typeStr = typeToString(resolved.type);
      const oid = hashObject(typeStr, resolved.data);
      objectsToStore.push({ oid, type: typeStr, data: resolved.data });
    }

    if (failed > 0) {
      console.warn(`[API] unpack: failed to resolve ${failed} objects`);
    }

    console.log(`[API] unpack: storing ${objectsToStore.length} objects in parallel batches`);

    const BATCH_SIZE = 50;
    let stored = 0;

    for (let i = 0; i < objectsToStore.length; i += BATCH_SIZE) {
      const batch = objectsToStore.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(obj => storeObject(obj.oid, obj.type, obj.data)));
      stored += batch.length;

      if (stored % 500 === 0 || stored === objectsToStore.length) {
        console.log(`[API] unpack: stored ${stored}/${objectsToStore.length} objects`);
        forceGCIfNeeded();
      }

      if (stored % 1000 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return { success: true, objectCount: stored };
  } catch (error) {
    console.error("[API] unpack error:", error);
    return { success: false, objectCount: 0, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

app.post("/:owner/:name/git-receive-pack", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = await resolveGitUser(c);

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canWriteRepository(repo, currentUser))) {
    return unauthorizedBasic();
  }

  const contentLength = c.req.header('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > GIT_MAX_OBJECTS_PER_PUSH * 1024) {
      console.warn(`[API] receive-pack: request size ${size} too large`);
      return c.json({ error: "Request too large" }, 413);
    }
  }

  console.log(`[API] receive-pack: received request for ${owner}/${name}`);
  const body = await c.req.arrayBuffer();
  const requestData = Buffer.from(body);
  console.log(`[API] receive-pack: received ${requestData.length} bytes`);

  if (requestData.length > GIT_MAX_OBJECTS_PER_PUSH * 1024) {
    console.warn(`[API] receive-pack: pack size ${requestData.length} too large`);
    return c.json({ error: "Pack file too large" }, 413);
  }

  try {

    const packSignature = Buffer.from([0x50, 0x41, 0x43, 0x4b]);
    let packStart = -1;

    for (let i = 0; i <= requestData.length - 4; i++) {
      if (requestData.slice(i, i + 4).equals(packSignature)) {
        packStart = i;
        break;
      }
    }

    if (packStart === -1) {
      const unpackOk = "unpack ok\n";
      const unpackOkLen = unpackOk.length + 4;
      const response = Buffer.concat([
        Buffer.from(unpackOkLen.toString(16).padStart(4, "0") + unpackOk, "ascii"),
        Buffer.from("0000", "ascii"),
      ]);
      return new Response(response, {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-receive-pack-result",
          "Cache-Control": "no-cache",
        },
      });
    }

    const commandSection = requestData.slice(0, packStart);
    const packData = requestData.slice(packStart);

    console.log(`[API] receive-pack: command section ${commandSection.length} bytes, pack data ${packData.length} bytes`);

    const commands = parsePktLines(commandSection);
    console.log(`[API] receive-pack: parsed ${commands.length} commands`);

    const updates: Array<{ oldOid: string; newOid: string; ref: string }> = [];

    for (const line of commands) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[0].length === 40 && parts[1].length === 40) {
        const refName = parts[2].split("\0")[0];
        updates.push({
          oldOid: parts[0],
          newOid: parts[1],
          ref: refName,
        });
      }
    }

    console.log(`[API] receive-pack: processing ${updates.length} ref updates`);

    const storeObject = async (oid: string, type: string, data: Buffer) => {
      const prefix = oid.substring(0, 2);
      const suffix = oid.substring(2);
      const objectPath = `repos/${repo.storageOwnerId}/${repo.name}/objects/${prefix}/${suffix}`;

      const header = `${type} ${data.length}\0`;
      const store = Buffer.concat([Buffer.from(header), data]);
      const compressed = await deflate(store);

      await putObject(objectPath, compressed);
    };

    const basePath = `repos/${repo.storageOwnerId}/${repo.name}`;
    console.log(`[API] receive-pack: unpacking pack file (${packData.length} bytes)`);
    const unpackResult = await unpackPackFile(packData, storeObject, basePath);
    if (!unpackResult.success) {
      console.error(`[API] receive-pack: unpack failed: ${unpackResult.error}`);
      throw new Error(unpackResult.error || "Failed to unpack");
    }
    console.log(`[API] receive-pack: unpacked ${unpackResult.objectCount} objects`);

    for (const update of updates) {
      const refPath = update.ref.startsWith("refs/") ? update.ref : `refs/heads/${update.ref}`;
      const refKey = `repos/${repo.storageOwnerId}/${repo.name}/${refPath}`;

      if (update.newOid === "0".repeat(40)) {
        await deleteObject(refKey).catch(() => {});
      } else {
        await putObject(refKey, Buffer.from(update.newOid + "\n"));

      }
    }

    if (updates.length > 0) {
      const defaultBranch = updates[0].ref.startsWith("refs/")
        ? updates[0].ref.replace("refs/heads/", "")
        : updates[0].ref;
      const headRef = `refs/heads/${defaultBranch}`;
      const headKey = `repos/${repo.storageOwnerId}/${repo.name}/HEAD`;
      await putObject(headKey, Buffer.from(`ref: ${headRef}\n`));


      for (const update of updates) {
        const branch = update.ref.startsWith("refs/heads/")
          ? update.ref.replace("refs/heads/", "")
          : update.ref;
        await repoCache.invalidateBranch(repo.storageOwnerId, repo.name, branch);
      }

      // Sync workflows and trigger CI — fire-and-forget
      for (const update of updates) {
        if (update.newOid !== "0".repeat(40) && update.ref.startsWith("refs/heads/")) {
          const branch = update.ref.replace("refs/heads/", "");
          syncWorkflows(repo.id).catch(() => {});
          triggerWorkflows({
            repoId: repo.id,
            branch,
            commitSha: update.newOid,
            eventName: "push",
            triggeredBy: currentUser?.id,
          }).catch(() => {});
        }
      }
    }

    console.log(`[API] receive-pack: building response for ${updates.length} updates`);

    let response = "";
    const unpackOk = "unpack ok\n";
    const unpackOkLen = unpackOk.length + 4;
    response += unpackOkLen.toString(16).padStart(4, "0") + unpackOk;

    for (const update of updates) {
      const line = `ok ${update.ref}\n`;
      const lineLen = line.length + 4;
      response += lineLen.toString(16).padStart(4, "0") + line;
    }

    response += "0000";

    console.log(`[API] receive-pack: sending response (${response.length} bytes)`);

    return new Response(Buffer.from(response, "ascii"), {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-receive-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("[API] receive-pack error:", error);
    const errorText = error instanceof Error ? error.message : "unpack error";
    const errorLine = `ng ${errorText}\n`;
    const errorLen = errorLine.length + 4;
    const response = errorLen.toString(16).padStart(4, "0") + errorLine + "0000";
    return new Response(Buffer.from(response, "ascii"), {
      status: 200,
      headers: {
        "Content-Type": "application/x-git-receive-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  }
});

export default app;
