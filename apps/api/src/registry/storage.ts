/**
 * OCI Distribution (Docker Registry) v2 storage layout.
 * Uses existing S3/local storage with prefix registry/.
 *
 * Layout:
 * - registry/<owner>/<image>/blobs/<alg>/<digestHex>  -> blob content
 * - registry/<owner>/<image>/manifests/<ref>          -> manifest (ref = tag or digest)
 * - registry/_uploads/<uuid>                          -> in-progress blob upload (temp)
 */

import { createHash } from "crypto";
import {
  getObject,
  putObject,
  objectExists,
  listObjects,
  getObjectStream,
  deletePrefix,
} from "../storage";
import { REGISTRY_MAX_BLOB_BYTES } from "../middleware/limits";

const REGISTRY_PREFIX = "registry/";
const UPLOADS_PREFIX = "registry/_uploads/";

type UploadIndex = {
  chunks: string[];
  size: number;
};

type ChunkedBlobIndex = {
  kind: "chunked-v1";
  chunks: string[];
  size: number;
};

export function getRegistryBlobKey(owner: string, imageName: string, digest: string): string {
  const normalized = digest.replace(":", "/");
  return `${REGISTRY_PREFIX}${owner}/${imageName}/blobs/${normalized}`;
}

function getRegistryBlobChunkIndexKey(owner: string, imageName: string, digest: string): string {
  return `${getRegistryBlobKey(owner, imageName, digest)}.chunks.json`;
}

function getRegistryBlobChunkKey(owner: string, imageName: string, digest: string, index: number): string {
  const normalized = digest.replace(":", "/");
  return `${REGISTRY_PREFIX}${owner}/${imageName}/blob-chunks/${normalized}/${index}`;
}

export function getRegistryManifestKey(owner: string, imageName: string, ref: string): string {
  return `${REGISTRY_PREFIX}${owner}/${imageName}/manifests/${ref}`;
}

function getUploadPrefix(uuid: string): string {
  return `${UPLOADS_PREFIX}${uuid}`;
}

function getUploadIndexKey(uuid: string): string {
  return `${getUploadPrefix(uuid)}/index.json`;
}

function getUploadChunkKey(uuid: string, index: number): string {
  return `${getUploadPrefix(uuid)}/chunks/${index}`;
}

async function readUploadIndex(uuid: string): Promise<UploadIndex> {
  const raw = await getObject(getUploadIndexKey(uuid));
  if (!raw) return { chunks: [], size: 0 };
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as UploadIndex;
    if (!Array.isArray(parsed.chunks) || typeof parsed.size !== "number") {
      return { chunks: [], size: 0 };
    }
    return parsed;
  } catch {
    return { chunks: [], size: 0 };
  }
}

async function writeUploadIndex(uuid: string, index: UploadIndex): Promise<void> {
  await putObject(getUploadIndexKey(uuid), Buffer.from(JSON.stringify(index), "utf8"), "application/json");
}

async function readChunkedBlobIndex(owner: string, imageName: string, digest: string): Promise<ChunkedBlobIndex | null> {
  const raw = await getObject(getRegistryBlobChunkIndexKey(owner, imageName, digest));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as ChunkedBlobIndex;
    if (parsed.kind !== "chunked-v1" || !Array.isArray(parsed.chunks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getUploadKey(uuid: string): string {
  return getUploadPrefix(uuid);
}

export function parseImageName(name: string): { owner: string; imageName: string } | null {
  const parts = name.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const imageName = parts.slice(1).join("/");
  if (!owner || !imageName) return null;
  return { owner, imageName };
}

export async function getBlob(owner: string, imageName: string, digest: string): Promise<Buffer | null> {
  const key = getRegistryBlobKey(owner, imageName, digest);
  return getObject(key);
}

export async function putBlob(owner: string, imageName: string, digest: string, content: Buffer): Promise<void> {
  const key = getRegistryBlobKey(owner, imageName, digest);
  await putObject(key, content);
}

async function writeChunkedBlobIndex(
  owner: string,
  imageName: string,
  digest: string,
  chunkKeys: string[],
  total: number,
): Promise<void> {
  const indexPayload: ChunkedBlobIndex = {
    kind: "chunked-v1",
    chunks: chunkKeys,
    size: total,
  };

  await putObject(getRegistryBlobKey(owner, imageName, digest), Buffer.alloc(0));
  await putObject(
    getRegistryBlobChunkIndexKey(owner, imageName, digest),
    Buffer.from(JSON.stringify(indexPayload), "utf8"),
    "application/json",
  );
}

export async function blobExists(owner: string, imageName: string, digest: string): Promise<boolean> {
  const key = getRegistryBlobKey(owner, imageName, digest);
  return objectExists(key);
}

export async function getManifest(owner: string, imageName: string, ref: string): Promise<Buffer | null> {
  const key = getRegistryManifestKey(owner, imageName, ref);
  return getObject(key);
}

export async function putManifest(owner: string, imageName: string, ref: string, content: Buffer, contentType?: string): Promise<void> {
  const key = getRegistryManifestKey(owner, imageName, ref);
  await putObject(key, content, contentType);
}

export async function manifestExists(owner: string, imageName: string, ref: string): Promise<boolean> {
  const key = getRegistryManifestKey(owner, imageName, ref);
  return objectExists(key);
}

export async function getManifestStream(owner: string, imageName: string, ref: string): Promise<ReadableStream | null> {
  const key = getRegistryManifestKey(owner, imageName, ref);
  return getObjectStream(key);
}

export async function listManifestRefs(owner: string, imageName: string): Promise<string[]> {
  const prefix = `${REGISTRY_PREFIX}${owner}/${imageName}/manifests/`;
  const keys = await listObjects(prefix);
  return keys
    .map((k) => k.slice(prefix.length))
    .filter(Boolean)
    .filter((ref) => !/^sha[0-9]+:[a-f0-9]+$/i.test(ref));
}

export async function startUpload(uuid: string): Promise<void> {
  await writeUploadIndex(uuid, { chunks: [], size: 0 });
}

export async function getUploadSize(uuid: string): Promise<number> {
  const index = await readUploadIndex(uuid);
  return index.size;
}

export async function appendUploadChunk(uuid: string, chunk: Buffer): Promise<{ size: number }> {
  const index = await readUploadIndex(uuid);
  if (index.size + chunk.length > REGISTRY_MAX_BLOB_BYTES) {
    throw new Error("Upload exceeds maximum blob size");
  }

  const chunkKey = getUploadChunkKey(uuid, index.chunks.length);
  await putObject(chunkKey, chunk);
  const updated: UploadIndex = {
    chunks: [...index.chunks, chunkKey],
    size: index.size + chunk.length,
  };
  await writeUploadIndex(uuid, updated);
  return { size: updated.size };
}

export async function finalizeUpload(
  owner: string,
  imageName: string,
  uuid: string,
  digest: string,
  trailingChunk?: Buffer,
): Promise<{ ok: true } | { ok: false; reason: "missing" | "digest_mismatch" | "too_large" }> {
  const index = await readUploadIndex(uuid);
  const hasChunks = index.chunks.length > 0;
  const hasTrailing = Boolean(trailingChunk && trailingChunk.length > 0);
  const totalSize = index.size + (trailingChunk?.length ?? 0);

  if (!hasChunks && !hasTrailing) {
    return { ok: false, reason: "missing" };
  }

  if (totalSize > REGISTRY_MAX_BLOB_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const hash = createHash("sha256");

  if (!hasChunks && hasTrailing && trailingChunk) {
    hash.update(trailingChunk);
    const computed = `sha256:${hash.digest("hex")}`;
    if (computed !== digest) {
      return { ok: false, reason: "digest_mismatch" };
    }
    await putBlob(owner, imageName, digest, trailingChunk);
    await deleteUpload(uuid);
    return { ok: true };
  }

  const chunkKeys: string[] = [];
  let total = 0;
  let nextIndex = 0;

  for (const uploadChunkKey of index.chunks) {
    const chunk = await getObject(uploadChunkKey);
    if (!chunk) return { ok: false, reason: "missing" };
    hash.update(chunk);

    const targetKey = getRegistryBlobChunkKey(owner, imageName, digest, nextIndex++);
    await putObject(targetKey, chunk);
    chunkKeys.push(targetKey);
    total += chunk.length;
  }

  if (hasTrailing && trailingChunk) {
    hash.update(trailingChunk);
    const targetKey = getRegistryBlobChunkKey(owner, imageName, digest, nextIndex);
    await putObject(targetKey, trailingChunk);
    chunkKeys.push(targetKey);
    total += trailingChunk.length;
  }

  const computed = `sha256:${hash.digest("hex")}`;
  if (computed !== digest) {
    return { ok: false, reason: "digest_mismatch" };
  }

  await writeChunkedBlobIndex(owner, imageName, digest, chunkKeys, total);
  await deleteUpload(uuid);
  return { ok: true };
}

export async function deleteUpload(uuid: string): Promise<void> {
  await deletePrefix(getUploadPrefix(uuid));
}

async function pipeStreamToController(
  stream: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      controller.enqueue(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamBlob(owner: string, imageName: string, digest: string): Promise<ReadableStream | null> {
  const chunked = await readChunkedBlobIndex(owner, imageName, digest);
  if (!chunked) {
    const key = getRegistryBlobKey(owner, imageName, digest);
    return getObjectStream(key);
  }

  return new ReadableStream({
    async start(controller) {
      try {
        for (const key of chunked.chunks) {
          const chunkStream = await getObjectStream(key);
          if (!chunkStream) {
            throw new Error("Missing blob chunk");
          }
          await pipeStreamToController(chunkStream, controller);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
