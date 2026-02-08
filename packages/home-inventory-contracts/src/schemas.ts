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

export const ItemCategorySchema = z.enum([
  "grain",
  "produce",
  "protein",
  "dairy",
  "snack",
  "beverage",
  "household",
  "condiment",
  "frozen",
  "other",
]);

export const ReceiptStatusSchema = z.enum(["uploaded", "processing", "parsed", "failed"]);
export const JobStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export const InventoryEventTypeSchema = z.enum(["add", "consume", "adjust", "waste"]);

export const IdSchema = z.string().min(1).max(128);

export const ReceiptItemSchema = z.object({
  itemKey: z.string().min(1).max(160),
  rawName: z.string().min(1).max(240),
  normalizedName: z.string().min(1).max(240),
  quantity: z.number().positive(),
  unit: UnitSchema,
  category: ItemCategorySchema,
  confidence: z.number().min(0).max(1),
  unitPrice: z.number().nonnegative().optional(),
  lineTotal: z.number().nonnegative().optional(),
});

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

export const ReceiptUploadRecordSchema = z.object({
  receiptUploadId: IdSchema,
  householdId: IdSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  path: z.string().min(1),
  status: ReceiptStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  merchantName: z.string().min(1).max(120).optional(),
  purchasedAt: z.iso.datetime().optional(),
  ocrText: z.string().max(20000).optional(),
  items: z.array(ReceiptItemSchema).optional(),
});

export const ReceiptDetailsResponseSchema = z.object({
  receipt: ReceiptUploadRecordSchema,
});

export const ReceiptProcessRequestSchema = z.object({
  householdId: IdSchema,
  ocrText: z.string().min(1).max(20000).optional(),
  merchantName: z.string().min(1).max(120).optional(),
  purchasedAt: z.iso.datetime().optional(),
});

export const ReceiptProcessJobSchema = z.object({
  jobId: IdSchema,
  receiptUploadId: IdSchema,
  householdId: IdSchema,
  status: JobStatusSchema,
  attempts: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: z.string().optional(),
  notes: z.string().optional(),
});

export const ClaimedJobSchema = z.object({
  job: ReceiptProcessJobSchema,
  receipt: ReceiptUploadRecordSchema,
});

export const EnqueueJobResponseSchema = z.object({
  job: ReceiptProcessJobSchema,
});

export const ClaimJobResponseSchema = z.object({
  job: ClaimedJobSchema.nullable(),
});

export const JobResultRequestSchema = z.object({
  merchantName: z.string().min(1).max(120).optional(),
  purchasedAt: z.iso.datetime().optional(),
  ocrText: z.string().min(1).max(20000).optional(),
  items: z.array(ReceiptItemSchema).min(1),
  notes: z.string().max(2000).optional(),
});

export const JobResultResponseSchema = z.object({
  job: ReceiptProcessJobSchema,
  receipt: ReceiptUploadRecordSchema,
});

export const CompleteJobRequestSchema = z.object({
  notes: z.string().max(2000).optional(),
});

export const FailJobRequestSchema = z.object({
  error: z.string().min(1).max(2000),
});

export const InventoryLotSchema = z.object({
  lotId: IdSchema,
  householdId: IdSchema,
  itemKey: z.string().min(1).max(160),
  itemName: z.string().min(1).max(240),
  quantityRemaining: z.number().nonnegative(),
  unit: UnitSchema,
  category: ItemCategorySchema,
  purchasedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
});

export const InventoryEventSchema = z.object({
  eventId: IdSchema,
  householdId: IdSchema,
  lotId: IdSchema,
  eventType: InventoryEventTypeSchema,
  quantity: z.number().positive(),
  unit: UnitSchema,
  source: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
  createdAt: z.iso.datetime(),
});

export const InventorySnapshotResponseSchema = z.object({
  householdId: IdSchema,
  lots: z.array(InventoryLotSchema),
  events: z.array(InventoryEventSchema),
});

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("home-inventory-api"),
  now: z.iso.datetime(),
});

export type Unit = z.infer<typeof UnitSchema>;
export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type InventoryEventType = z.infer<typeof InventoryEventTypeSchema>;
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type ReceiptUploadRequest = z.infer<typeof ReceiptUploadRequestSchema>;
export type ReceiptUploadResponse = z.infer<typeof ReceiptUploadResponseSchema>;
export type ReceiptUploadRecord = z.infer<typeof ReceiptUploadRecordSchema>;
export type ReceiptDetailsResponse = z.infer<typeof ReceiptDetailsResponseSchema>;
export type ReceiptProcessRequest = z.infer<typeof ReceiptProcessRequestSchema>;
export type ReceiptProcessJob = z.infer<typeof ReceiptProcessJobSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type EnqueueJobResponse = z.infer<typeof EnqueueJobResponseSchema>;
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;
export type JobResultRequest = z.infer<typeof JobResultRequestSchema>;
export type JobResultResponse = z.infer<typeof JobResultResponseSchema>;
export type CompleteJobRequest = z.infer<typeof CompleteJobRequestSchema>;
export type FailJobRequest = z.infer<typeof FailJobRequestSchema>;
export type InventoryLot = z.infer<typeof InventoryLotSchema>;
export type InventoryEvent = z.infer<typeof InventoryEventSchema>;
export type InventorySnapshotResponse = z.infer<typeof InventorySnapshotResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
