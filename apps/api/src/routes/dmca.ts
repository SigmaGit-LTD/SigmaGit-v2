import { Hono } from "hono";
import { db, dmcaRequests } from "@sigmagit/db";
import { authMiddleware, type AuthVariables } from "../middleware/auth";

const DMCA_TARGET_TYPES = ["repository", "gist"] as const;
type DmcaTargetType = (typeof DMCA_TARGET_TYPES)[number];

function isDmcaTargetType(value: unknown): value is DmcaTargetType {
  return typeof value === "string" && DMCA_TARGET_TYPES.includes(value as DmcaTargetType);
}

const app = new Hono<{ Variables: AuthVariables }>();


app.post("/api/dmca", async (c) => {
  const user = c.get("user");

  const body = await c.req.json().catch(() => ({}));
  const targetType = body.targetType;
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const copyrightHolder = typeof body.copyrightHolder === "string" ? body.copyrightHolder.trim() : "";
  const copyrightHolderEmail = typeof body.copyrightHolderEmail === "string" ? body.copyrightHolderEmail.trim() : "";
  const copyrightHolderAddress = typeof body.copyrightHolderAddress === "string" ? body.copyrightHolderAddress.trim() : "";
  const copyrightHolderPhone = typeof body.copyrightHolderPhone === "string" ? body.copyrightHolderPhone.trim() || null : null;
  const originalWorkDescription = typeof body.originalWorkDescription === "string" ? body.originalWorkDescription.trim() : "";
  const originalWorkUrl = typeof body.originalWorkUrl === "string" ? body.originalWorkUrl.trim() || null : null;
  const infringingUrls = typeof body.infringingUrls === "string" ? body.infringingUrls.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const swornStatement = body.swornStatement === true;
  const perjuryStatement = body.perjuryStatement === true;
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";

  if (!isDmcaTargetType(targetType)) {
    return c.json({ error: "Invalid targetType" }, 400);
  }
  if (!targetId) {
    return c.json({ error: "targetId is required" }, 400);
  }
  if (!copyrightHolder) {
    return c.json({ error: "copyrightHolder is required" }, 400);
  }
  if (!copyrightHolderEmail) {
    return c.json({ error: "copyrightHolderEmail is required" }, 400);
  }
  if (!copyrightHolderAddress) {
    return c.json({ error: "copyrightHolderAddress is required" }, 400);
  }
  if (!originalWorkDescription) {
    return c.json({ error: "originalWorkDescription is required" }, 400);
  }
  if (!infringingUrls) {
    return c.json({ error: "infringingUrls is required" }, 400);
  }
  if (!description) {
    return c.json({ error: "description is required" }, 400);
  }
  if (!swornStatement || !perjuryStatement) {
    return c.json({ error: "Both swornStatement and perjuryStatement must be accepted" }, 400);
  }
  if (!signature) {
    return c.json({ error: "signature is required" }, 400);
  }

  const [request] = await db
    .insert(dmcaRequests)
    .values({
      requesterId: user?.id ?? null,
      targetType,
      targetId,
      copyrightHolder,
      copyrightHolderEmail,
      copyrightHolderAddress,
      copyrightHolderPhone,
      originalWorkDescription,
      originalWorkUrl,
      infringingUrls,
      description,
      swornStatement,
      perjuryStatement,
      signature,
      status: "pending",
    })
    .returning();

  return c.json({ data: request }, 201);
});

export default app;
