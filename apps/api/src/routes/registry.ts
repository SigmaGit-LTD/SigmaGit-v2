/**
 * OCI Distribution (Docker Registry) v2 API implementation.
 * Mount at root so that /v2/ and /api/registry/token are served.
 *
 * Usage:
 *   docker login <api-host>   # username + password or username + API key
 *   docker push <api-host>/owner/image:tag
 *   docker pull <api-host>/owner/image:tag
 */

import { Hono } from "hono";
import { createHash } from "crypto";
import { randomUUID } from "crypto";
import { getApiUrl } from "../config";
import { readRequestBodyLimited, RequestBodyTooLargeError } from "../lib/request-body";
import { REGISTRY_MAX_BLOB_BYTES, REGISTRY_MAX_CHUNK_BYTES } from "../middleware/limits";
import {
  parseImageName,
  blobExists,
  getManifest,
  putManifest,
  manifestExists,
  listManifestRefs,
  startUpload,
  getUploadSize,
  appendUploadChunk,
  finalizeUpload,
  deleteUpload,
  streamBlob,
} from "../registry/storage";
import {
  resolveRegistryBasicAuth,
  issueRegistryToken,
  verifyRegistryToken,
  canPushRegistry,
  canPullRegistry,
  type RegistryClaims,
} from "../registry/auth";
import type { AuthUser } from "../middleware/auth";

const REGISTRY_REALM_PATH = "/api/registry/token";

function getNameFromWildcard(c: { req: { param: (name: string) => string } }): string {
  return c.req.param("*");
}

function registryChallenge(scope: string): Response {
  const realm = new URL(REGISTRY_REALM_PATH, getApiUrl()).toString();
  return new Response(undefined, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer realm="${realm}",service="registry",scope="${scope}"`,
    },
  });
}

function parseScope(scope: string): { repo: string; actions: ("pull" | "push")[] } | null {
  const m = scope.match(/^repository:([^:]+):(.+)$/);
  if (!m) return null;
  return { repo: m[1], actions: m[2].split(",").map((a) => a.trim()) as ("pull" | "push")[] };
}

/** Get Bearer token from request, or null. Optionally validate scope matches repo. */
function getRegistryAuth(c: { req: { header: (n: string) => string | undefined } }, requiredRepo?: string): { claims: RegistryClaims } | null {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  const claims = verifyRegistryToken(token);
  if (!claims) return null;
  if (requiredRepo && claims.repo !== requiredRepo) return null;
  return { claims };
}

/** Require auth for repo; return 401 challenge if missing/invalid. */
async function requireRegistryAuth(
  c: { req: { header: (n: string) => string | undefined }; json: (body: unknown, status?: number) => Response },
  repo: string,
  action: "pull" | "push"
): Promise<{ user: AuthUser; claims: RegistryClaims } | Response> {
  const bearer = getRegistryAuth(c, repo);
  if (bearer && bearer.claims.access.includes(action)) {
    const user: AuthUser = {
      id: bearer.claims.sub,
      name: "",
      email: "",
      username: bearer.claims.username,
      avatarUrl: null,
    };
    return { user, claims: bearer.claims };
  }
  const scope = `repository:${repo}:${action}`;
  return registryChallenge(scope);
}

const app = new Hono();

// ----- Token endpoint (Docker login flow) -----
app.get(REGISTRY_REALM_PATH, async (c) => {
  const service = c.req.query("service");
  const scope = c.req.query("scope");
  if (service !== "registry" || !scope) {
    return c.json({ error: "service and scope required" }, 400);
  }
  const parsed = parseScope(scope);
  if (!parsed) {
    return c.json({ error: "invalid scope" }, 400);
  }
  const user = await resolveRegistryBasicAuth(c.req.header("Authorization"));
  if (!user) {
    return new Response(undefined, {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="registry"' },
    });
  }
  const { owner, imageName } = parseImageName(parsed.repo) ?? {};
  if (!owner || !imageName) {
    return c.json({ error: "invalid repository name" }, 400);
  }
  const access: ("pull" | "push")[] = [];
  if (parsed.actions.includes("pull") && (await canPullRegistry(user, owner, imageName))) access.push("pull");
  if (parsed.actions.includes("push") && (await canPushRegistry(user, owner, imageName))) access.push("push");
  if (access.length === 0) {
    return c.json({ error: "access denied" }, 403);
  }
  const token = issueRegistryToken({
    sub: user.id,
    username: user.username,
    access,
    repo: parsed.repo,
  });
  return c.json({ token });
});

// ----- v2 API -----

app.get("/v2/", async (c) => {
  return c.body("", 200, {
    "Content-Length": "0",
    "Docker-Distribution-Api-Version": "registry/2.0",
  });
});

// Manifest: GET /v2/<name>/manifests/<ref>
app.get("/v2/*/manifests/:ref", async (c) => {
  const name = getNameFromWildcard(c);
  const ref = c.req.param("ref");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID", message: "invalid name" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "pull");
  if (authResult instanceof Response) return authResult;
  const manifest = await getManifest(owner, imageName, ref);
  if (!manifest) return c.json({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] }, 404);
  const contentType = c.req.header("Accept")?.includes("application/vnd.oci.image.manifest.v1+json")
    ? "application/vnd.oci.image.manifest.v1+json"
    : "application/vnd.docker.distribution.manifest.v2+json";
  const digest = ref.startsWith("sha256:") ? ref : `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  return new Response(manifest, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Docker-Content-Digest": digest,
    },
  });
});

// HEAD /v2/<name>/manifests/<ref> is handled by the GET route above (Hono strips body for HEAD).

// Manifest: PUT /v2/<name>/manifests/<ref>
app.put("/v2/*/manifests/:ref", async (c) => {
  const name = getNameFromWildcard(c);
  const ref = c.req.param("ref");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "push");
  if (authResult instanceof Response) return authResult;
  let manifest: Buffer;
  try {
    manifest = await readRequestBodyLimited(c.req.raw, REGISTRY_MAX_BLOB_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: "manifest too large" }] }, 413);
    }
    throw error;
  }
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  if (ref.startsWith("sha256:") && ref !== digest) {
    return c.json({ errors: [{ code: "DIGEST_INVALID", message: "manifest digest mismatch" }] }, 400);
  }
  const contentType = c.req.header("Content-Type") ?? "application/vnd.oci.image.manifest.v1+json";
  await putManifest(owner, imageName, ref, manifest, contentType);
  if (ref !== digest) {
    await putManifest(owner, imageName, digest, manifest, contentType);
  }
  return c.body("", 201, {
    "Docker-Content-Digest": digest,
    "Content-Length": "0",
  });
});

// Blob: GET /v2/<name>/blobs/<digest>
app.get("/v2/*/blobs/:digest", async (c) => {
  const name = getNameFromWildcard(c);
  const digest = c.req.param("digest");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "pull");
  if (authResult instanceof Response) return authResult;
  const stream = await streamBlob(owner, imageName, digest);
  if (!stream) return c.json({ errors: [{ code: "BLOB_UNKNOWN", message: "blob unknown" }] }, 404);
  return new Response(stream, {
    status: 200,
    headers: { "Docker-Content-Digest": digest.startsWith("sha256:") ? digest : `sha256:${digest}` },
  });
});

// HEAD /v2/<name>/blobs/<digest> is handled by the GET route above (Hono strips body for HEAD).

// Blob upload: POST /v2/<name>/blobs/uploads/
app.post("/v2/*/blobs/uploads/", async (c) => {
  const name = getNameFromWildcard(c);
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "push");
  if (authResult instanceof Response) return authResult;
  const uuid = randomUUID();
  await startUpload(uuid);
  const location = `${getApiUrl()}/v2/${name}/blobs/uploads/${uuid}`;
  return c.body("", 202, {
    "Location": location,
    "Content-Length": "0",
    "Docker-Upload-UUID": uuid,
  });
});

// Blob upload: PUT /v2/<name>/blobs/uploads/<uuid>?digest=sha256:xxx
app.put("/v2/*/blobs/uploads/:uuid", async (c) => {
  const name = getNameFromWildcard(c);
  const uuid = c.req.param("uuid");
  const digest = c.req.query("digest");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  if (!digest || !digest.startsWith("sha256:")) {
    return c.json({ errors: [{ code: "DIGEST_INVALID", message: "digest query required" }] }, 400);
  }
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "push");
  if (authResult instanceof Response) return authResult;
  let trailing: Buffer | undefined;
  try {
    const body = await readRequestBodyLimited(c.req.raw, REGISTRY_MAX_CHUNK_BYTES);
    trailing = body.byteLength > 0 ? body : undefined;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: "chunk too large" }] }, 413);
    }
    throw error;
  }
  const finalize = await finalizeUpload(owner, imageName, uuid, digest, trailing);
  if (!finalize.ok) {
    if (finalize.reason === "digest_mismatch") {
      return c.json({ errors: [{ code: "DIGEST_INVALID", message: "digest mismatch" }] }, 400);
    }
    if (finalize.reason === "too_large") {
      return c.json({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: "blob too large" }] }, 413);
    }
    return c.json({ errors: [{ code: "BLOB_UNKNOWN", message: "no content" }] }, 400);
  }
  return c.body("", 201, {
    "Docker-Content-Digest": digest,
    "Content-Length": "0",
  });
});

// Blob upload: PATCH /v2/<name>/blobs/uploads/<uuid> (optional chunked upload)
app.patch("/v2/*/blobs/uploads/:uuid", async (c) => {
  const name = getNameFromWildcard(c);
  const uuid = c.req.param("uuid");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "push");
  if (authResult instanceof Response) return authResult;
  let chunk: Buffer;
  try {
    chunk = await readRequestBodyLimited(c.req.raw, REGISTRY_MAX_CHUNK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: "chunk too large" }] }, 413);
    }
    throw error;
  }

  let result: { size: number };
  try {
    result = chunk.length > 0 ? await appendUploadChunk(uuid, chunk) : { size: await getUploadSize(uuid) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("maximum blob size")) {
      return c.json({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: "blob too large" }] }, 413);
    }
    throw error;
  }
  const location = `${getApiUrl()}/v2/${name}/blobs/uploads/${uuid}`;
  const end = result.size > 0 ? result.size - 1 : 0;
  return c.body("", 202, {
    "Location": location,
    "Docker-Upload-UUID": uuid,
    "Range": `0-${end}`,
  });
});

// Blob upload: DELETE /v2/<name>/blobs/uploads/<uuid>
app.delete("/v2/*/blobs/uploads/:uuid", async (c) => {
  const name = getNameFromWildcard(c);
  const uuid = c.req.param("uuid");
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "push");
  if (authResult instanceof Response) return authResult;
  await deleteUpload(uuid);
  return c.body(null, 204);
});

// Tags list: GET /v2/<name>/tags/list
app.get("/v2/*/tags/list", async (c) => {
  const name = getNameFromWildcard(c);
  const parsed = parseImageName(name);
  if (!parsed) return c.json({ errors: [{ code: "NAME_INVALID" }] }, 400);
  const { owner, imageName } = parsed;
  const authResult = await requireRegistryAuth(c, `${owner}/${imageName}`, "pull");
  if (authResult instanceof Response) return authResult;
  const refs = await listManifestRefs(owner, imageName);
  return c.json({ name: `${owner}/${imageName}`, tags: refs });
});

export default app;
