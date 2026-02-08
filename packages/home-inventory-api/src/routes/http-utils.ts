import type { Request, Response } from "express";
import type { ZodType } from "zod";

export function parseBody<T>(
  schema: ZodType<T>,
  req: Request,
  res: Response,
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
    return null;
  }
  return result.data;
}

export function parseParam(
  value: string | undefined,
  field: string,
  res: Response,
): string | null {
  if (!value || value.length === 0) {
    res.status(400).json({ error: "invalid_request", message: `missing path parameter: ${field}` });
    return null;
  }
  return value;
}

export function requireWorkerToken(req: Request, res: Response, expectedToken: string): boolean {
  const provided = req.header("x-home-inventory-worker-token") ?? "";
  if (provided !== expectedToken) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
