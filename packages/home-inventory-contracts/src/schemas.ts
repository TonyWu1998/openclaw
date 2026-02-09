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
export const ExpirySourceSchema = z.enum(["exact", "estimated", "unknown"]);

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
  receiptImageDataUrl: z.string().startsWith("data:image/").max(3_000_000).optional(),
  items: z.array(ReceiptItemSchema).optional(),
});

export const ReceiptDetailsResponseSchema = z.object({
  receipt: ReceiptUploadRecordSchema,
});

export const ReceiptReviewModeSchema = z.enum(["overwrite", "append"]);

export const ReceiptReviewRequestSchema = z.object({
  householdId: IdSchema,
  mode: ReceiptReviewModeSchema.default("overwrite"),
  items: z.array(ReceiptItemSchema).min(1),
  merchantName: z.string().min(1).max(120).optional(),
  purchasedAt: z.iso.datetime().optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const ReceiptReviewResponseSchema = z.object({
  receipt: ReceiptUploadRecordSchema,
  applied: z.boolean(),
  eventsCreated: z.number().int().min(0),
});

export const ReceiptProcessRequestSchema = z.object({
  householdId: IdSchema,
  ocrText: z.string().min(1).max(20000).optional(),
  receiptImageDataUrl: z.string().startsWith("data:image/").max(3_000_000).optional(),
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

export const JobStatusResponseSchema = z.object({
  job: ReceiptProcessJobSchema,
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
  expiresAt: z.iso.datetime().optional(),
  expiryEstimatedAt: z.iso.datetime().optional(),
  expirySource: ExpirySourceSchema.optional(),
  expiryConfidence: z.number().min(0).max(1).optional(),
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

export const ManualInventoryEntryRequestSchema = z.object({
  items: z.array(ReceiptItemSchema).min(1),
  purchasedAt: z.iso.datetime().optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const ManualInventoryEntryResponseSchema = z.object({
  householdId: IdSchema,
  inventory: InventorySnapshotResponseSchema,
  applied: z.boolean(),
  eventsCreated: z.number().int().min(0),
});

export const LotExpiryOverrideRequestSchema = z.object({
  householdId: IdSchema,
  expiresAt: z.iso.datetime(),
  notes: z.string().max(500).optional(),
});

export const LotExpiryOverrideResponseSchema = z.object({
  lot: InventoryLotSchema,
  eventsCreated: z.number().int().min(0),
});

export const ExpiryRiskLevelSchema = z.enum(["critical", "high", "medium", "low"]);

export const ExpiryRiskItemSchema = z.object({
  lotId: IdSchema,
  itemKey: z.string().min(1).max(160),
  itemName: z.string().min(1).max(240),
  category: ItemCategorySchema,
  quantityRemaining: z.number().nonnegative(),
  unit: UnitSchema,
  expiresAt: z.iso.datetime(),
  expirySource: ExpirySourceSchema,
  expiryConfidence: z.number().min(0).max(1),
  daysRemaining: z.number().int(),
  riskLevel: ExpiryRiskLevelSchema,
});

export const ExpiryRiskResponseSchema = z.object({
  householdId: IdSchema,
  asOf: z.iso.datetime(),
  items: z.array(ExpiryRiskItemSchema),
});

export const RecommendationRunTypeSchema = z.enum(["daily", "weekly"]);
export const RecommendationPrioritySchema = z.enum(["high", "medium", "low"]);
export const FeedbackSignalTypeSchema = z.enum([
  "accepted",
  "rejected",
  "edited",
  "ignored",
  "consumed",
  "wasted",
]);

export const RecommendationRunSchema = z.object({
  runId: IdSchema,
  householdId: IdSchema,
  runType: RecommendationRunTypeSchema,
  model: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  targetDate: z.iso.date(),
});

export const DailyMealRecommendationSchema = z.object({
  recommendationId: IdSchema,
  householdId: IdSchema,
  mealDate: z.iso.date(),
  title: z.string().min(1).max(200),
  cuisine: z.string().min(1).max(80),
  rationale: z.string().min(1).max(500),
  itemKeys: z.array(z.string().min(1).max(160)).min(1),
  score: z.number().min(0).max(1),
});

export const WeeklyPurchaseRecommendationSchema = z.object({
  recommendationId: IdSchema,
  householdId: IdSchema,
  weekOf: z.iso.date(),
  itemKey: z.string().min(1).max(160),
  itemName: z.string().min(1).max(240),
  quantity: z.number().positive(),
  unit: UnitSchema,
  priority: RecommendationPrioritySchema,
  rationale: z.string().min(1).max(500),
  score: z.number().min(0).max(1),
});

export const GenerateDailyRecommendationsRequestSchema = z.object({
  date: z.iso.date().optional(),
});

export const GenerateWeeklyRecommendationsRequestSchema = z.object({
  weekOf: z.iso.date().optional(),
});

export const DailyRecommendationsResponseSchema = z.object({
  run: RecommendationRunSchema,
  recommendations: z.array(DailyMealRecommendationSchema),
});

export const WeeklyRecommendationsResponseSchema = z.object({
  run: RecommendationRunSchema,
  recommendations: z.array(WeeklyPurchaseRecommendationSchema),
});

export const RecommendationFeedbackRequestSchema = z.object({
  householdId: IdSchema,
  signalType: FeedbackSignalTypeSchema,
  signalValue: z.number().min(-1).max(1).optional(),
  context: z.string().max(500).optional(),
});

export const RecommendationFeedbackRecordSchema = z.object({
  feedbackId: IdSchema,
  recommendationId: IdSchema,
  householdId: IdSchema,
  signalType: FeedbackSignalTypeSchema,
  signalValue: z.number().min(-1).max(1),
  context: z.string().max(500).optional(),
  createdAt: z.iso.datetime(),
});

export const RecommendationFeedbackResponseSchema = z.object({
  feedback: RecommendationFeedbackRecordSchema,
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
export type ExpirySource = z.infer<typeof ExpirySourceSchema>;
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type ReceiptUploadRequest = z.infer<typeof ReceiptUploadRequestSchema>;
export type ReceiptUploadResponse = z.infer<typeof ReceiptUploadResponseSchema>;
export type ReceiptUploadRecord = z.infer<typeof ReceiptUploadRecordSchema>;
export type ReceiptDetailsResponse = z.infer<typeof ReceiptDetailsResponseSchema>;
export type ReceiptReviewMode = z.infer<typeof ReceiptReviewModeSchema>;
export type ReceiptReviewRequest = z.infer<typeof ReceiptReviewRequestSchema>;
export type ReceiptReviewResponse = z.infer<typeof ReceiptReviewResponseSchema>;
export type ReceiptProcessRequest = z.infer<typeof ReceiptProcessRequestSchema>;
export type ReceiptProcessJob = z.infer<typeof ReceiptProcessJobSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type EnqueueJobResponse = z.infer<typeof EnqueueJobResponseSchema>;
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;
export type JobResultRequest = z.infer<typeof JobResultRequestSchema>;
export type JobResultResponse = z.infer<typeof JobResultResponseSchema>;
export type CompleteJobRequest = z.infer<typeof CompleteJobRequestSchema>;
export type FailJobRequest = z.infer<typeof FailJobRequestSchema>;
export type InventoryLot = z.infer<typeof InventoryLotSchema>;
export type InventoryEvent = z.infer<typeof InventoryEventSchema>;
export type InventorySnapshotResponse = z.infer<typeof InventorySnapshotResponseSchema>;
export type ManualInventoryEntryRequest = z.infer<typeof ManualInventoryEntryRequestSchema>;
export type ManualInventoryEntryResponse = z.infer<typeof ManualInventoryEntryResponseSchema>;
export type LotExpiryOverrideRequest = z.infer<typeof LotExpiryOverrideRequestSchema>;
export type LotExpiryOverrideResponse = z.infer<typeof LotExpiryOverrideResponseSchema>;
export type ExpiryRiskLevel = z.infer<typeof ExpiryRiskLevelSchema>;
export type ExpiryRiskItem = z.infer<typeof ExpiryRiskItemSchema>;
export type ExpiryRiskResponse = z.infer<typeof ExpiryRiskResponseSchema>;
export type RecommendationRunType = z.infer<typeof RecommendationRunTypeSchema>;
export type RecommendationPriority = z.infer<typeof RecommendationPrioritySchema>;
export type FeedbackSignalType = z.infer<typeof FeedbackSignalTypeSchema>;
export type RecommendationRun = z.infer<typeof RecommendationRunSchema>;
export type DailyMealRecommendation = z.infer<typeof DailyMealRecommendationSchema>;
export type WeeklyPurchaseRecommendation = z.infer<typeof WeeklyPurchaseRecommendationSchema>;
export type GenerateDailyRecommendationsRequest = z.infer<
  typeof GenerateDailyRecommendationsRequestSchema
>;
export type GenerateWeeklyRecommendationsRequest = z.infer<
  typeof GenerateWeeklyRecommendationsRequestSchema
>;
export type DailyRecommendationsResponse = z.infer<typeof DailyRecommendationsResponseSchema>;
export type WeeklyRecommendationsResponse = z.infer<typeof WeeklyRecommendationsResponseSchema>;
export type RecommendationFeedbackRequest = z.infer<typeof RecommendationFeedbackRequestSchema>;
export type RecommendationFeedbackRecord = z.infer<typeof RecommendationFeedbackRecordSchema>;
export type RecommendationFeedbackResponse = z.infer<typeof RecommendationFeedbackResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
