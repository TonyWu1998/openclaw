import { z } from "zod";

export const UnitSchema = z.enum([
  "count",
  "g",
  "kg",
  "ml",
  "l",
  "oz",
  "lb",
  "pack",
  "box",
  "bottle",
]);

export const IdSchema = z.string().min(1).max(128);

export const ReceiptUploadRequestSchema = z.object({
  householdId: IdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
});

export const ReceiptUploadResponseSchema = z.object({
  receiptUploadId: IdSchema,
  uploadUrl: z.url(),
  path: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export const ReceiptProcessRequestSchema = z.object({
  householdId: IdSchema,
});

export const JobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);

export const ReceiptProcessJobSchema = z.object({
  jobId: IdSchema,
  receiptUploadId: IdSchema,
  householdId: IdSchema,
  status: JobStatusSchema,
  attempts: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: z.string().optional(),
});

export const EnqueueJobResponseSchema = z.object({
  job: ReceiptProcessJobSchema,
});

export const ClaimJobResponseSchema = z.object({
  job: ReceiptProcessJobSchema.nullable(),
});

export const CompleteJobRequestSchema = z.object({
  notes: z.string().max(2000).optional(),
});

export const FailJobRequestSchema = z.object({
  error: z.string().min(1).max(2000),
});

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("home-inventory-api"),
  now: z.iso.datetime(),
});

export type Unit = z.infer<typeof UnitSchema>;
export type ReceiptUploadRequest = z.infer<typeof ReceiptUploadRequestSchema>;
export type ReceiptUploadResponse = z.infer<typeof ReceiptUploadResponseSchema>;
export type ReceiptProcessRequest = z.infer<typeof ReceiptProcessRequestSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ReceiptProcessJob = z.infer<typeof ReceiptProcessJobSchema>;
export type EnqueueJobResponse = z.infer<typeof EnqueueJobResponseSchema>;
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;
export type CompleteJobRequest = z.infer<typeof CompleteJobRequestSchema>;
export type FailJobRequest = z.infer<typeof FailJobRequestSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
