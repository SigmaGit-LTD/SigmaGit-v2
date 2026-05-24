import { Hono } from "hono";
import { db, reports } from "@sigmagit/db";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";

const REPORT_TARGET_TYPES = ["user", "repository", "gist", "organization"] as const;
const REPORT_REASONS = ["spam", "harassment", "inappropriate", "impersonation", "other"] as const;

type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
type ReportReason = (typeof REPORT_REASONS)[number];

function isReportTargetType(value: unknown): value is ReportTargetType {
  return typeof value === "string" && REPORT_TARGET_TYPES.includes(value as ReportTargetType);
}

function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && REPORT_REASONS.includes(value as ReportReason);
}

const app = new Hono<{ Variables: AuthVariables }>();


app.post("/api/reports", requireAuth, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const targetType = body.targetType;
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const reason = body.reason;
  const description = typeof body.description === "string" ? body.description.trim() : "";

  if (!isReportTargetType(targetType)) {
    return c.json({ error: "Invalid targetType" }, 400);
  }
  if (!targetId) {
    return c.json({ error: "targetId is required" }, 400);
  }
  if (!isReportReason(reason)) {
    return c.json({ error: "Invalid reason" }, 400);
  }
  if (!description) {
    return c.json({ error: "description is required" }, 400);
  }

  const [report] = await db
    .insert(reports)
    .values({
      reporterId: user.id,
      targetType,
      targetId,
      reason,
      description,
      status: "pending",
    })
    .returning();

  return c.json({ data: report }, 201);
});

export default app;
