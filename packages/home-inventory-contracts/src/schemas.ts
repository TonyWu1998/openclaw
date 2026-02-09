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

export const BatchReceiptProcessEntrySchema = ReceiptProcessRequestSchema.extend({
  receiptUploadId: IdSchema,
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const BatchReceiptProcessRequestSchema = z.object({
  receipts: z.array(BatchReceiptProcessEntrySchema).min(1).max(10),
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

export const BatchReceiptProcessResultSchema = z.object({
  receiptUploadId: IdSchema,
  householdId: IdSchema,
  accepted: z.boolean(),
  job: ReceiptProcessJobSchema.optional(),
  error: z.string().min(1).max(500).optional(),
});

export const BatchReceiptProcessResponseSchema = z.object({
  batchId: IdSchema,
  requested: z.number().int().min(1).max(10),
  accepted: z.number().int().min(0).max(10),
  rejected: z.number().int().min(0).max(10),
  results: z.array(BatchReceiptProcessResultSchema),
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

export const MealCheckinStatusSchema = z.enum(["pending", "completed", "needs_adjustment"]);
export const MealCheckinOutcomeSchema = z.enum(["made", "skipped", "partial"]);

export const MealCheckinLineSchema = z.object({
  itemKey: z.string().min(1).max(160),
  unit: UnitSchema,
  quantityConsumed: z.number().nonnegative().optional(),
  quantityWasted: z.number().nonnegative().optional(),
});

export const MealCheckinSchema = z.object({
  checkinId: IdSchema,
  recommendationId: IdSchema,
  householdId: IdSchema,
  mealDate: z.iso.date(),
  title: z.string().min(1).max(200),
  suggestedItemKeys: z.array(z.string().min(1).max(160)),
  status: MealCheckinStatusSchema,
  outcome: MealCheckinOutcomeSchema.optional(),
  lines: z.array(MealCheckinLineSchema).optional(),
  notes: z.string().max(500).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const MealCheckinPendingResponseSchema = z.object({
  householdId: IdSchema,
  checkins: z.array(MealCheckinSchema),
});

export const MealCheckinSubmitRequestSchema = z.object({
  householdId: IdSchema,
  outcome: MealCheckinOutcomeSchema,
  lines: z.array(MealCheckinLineSchema).optional(),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const MealCheckinSubmitResponseSchema = z.object({
  checkin: MealCheckinSchema,
  inventory: InventorySnapshotResponseSchema,
  eventsCreated: z.number().int().min(0),
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

export const ShoppingDraftStatusSchema = z.enum(["draft", "finalized"]);
export const ShoppingDraftItemStatusSchema = z.enum(["planned", "skipped", "purchased"]);

export const ShoppingDraftItemSchema = z.object({
  draftItemId: IdSchema,
  recommendationId: IdSchema.optional(),
  itemKey: z.string().min(1).max(160),
  itemName: z.string().min(1).max(240),
  quantity: z.number().positive(),
  unit: UnitSchema,
  priority: RecommendationPrioritySchema,
  rationale: z.string().min(1).max(500),
  itemStatus: ShoppingDraftItemStatusSchema,
  notes: z.string().max(300).optional(),
  lastUnitPrice: z.number().positive().optional(),
  avgUnitPrice30d: z.number().positive().optional(),
  minUnitPrice90d: z.number().positive().optional(),
  priceTrendPct: z.number().optional(),
  priceAlert: z.boolean(),
});

export const ShoppingDraftSchema = z.object({
  draftId: IdSchema,
  householdId: IdSchema,
  weekOf: z.iso.date(),
  status: ShoppingDraftStatusSchema,
  sourceRunId: IdSchema.optional(),
  items: z.array(ShoppingDraftItemSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().optional(),
});

export const ShoppingDraftGenerateRequestSchema = z.object({
  weekOf: z.iso.date().optional(),
  regenerate: z.boolean().optional(),
});

export const ShoppingDraftPatchItemSchema = z.object({
  draftItemId: IdSchema,
  quantity: z.number().positive().optional(),
  priority: RecommendationPrioritySchema.optional(),
  itemStatus: ShoppingDraftItemStatusSchema.optional(),
  notes: z.string().max(300).optional(),
});

export const ShoppingDraftPatchRequestSchema = z.object({
  householdId: IdSchema,
  items: z.array(ShoppingDraftPatchItemSchema).min(1),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const ShoppingDraftResponseSchema = z.object({
  draft: ShoppingDraftSchema,
  updated: z.boolean().optional(),
});

export const PantryHealthSubscoresSchema = z.object({
  stock_balance: z.number().min(0).max(100),
  expiry_risk: z.number().min(0).max(100),
  waste_pressure: z.number().min(0).max(100),
  plan_adherence: z.number().min(0).max(100),
  data_quality: z.number().min(0).max(100),
});

export const PantryHealthScoreSchema = z.object({
  householdId: IdSchema,
  asOf: z.iso.datetime(),
  score: z.number().min(0).max(100),
  subscores: PantryHealthSubscoresSchema,
});

export const PantryHealthHistoryResponseSchema = z.object({
  householdId: IdSchema,
  history: z.array(PantryHealthScoreSchema),
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
export type BatchReceiptProcessEntry = z.infer<typeof BatchReceiptProcessEntrySchema>;
export type BatchReceiptProcessRequest = z.infer<typeof BatchReceiptProcessRequestSchema>;
export type ReceiptProcessJob = z.infer<typeof ReceiptProcessJobSchema>;
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type EnqueueJobResponse = z.infer<typeof EnqueueJobResponseSchema>;
export type BatchReceiptProcessResult = z.infer<typeof BatchReceiptProcessResultSchema>;
export type BatchReceiptProcessResponse = z.infer<typeof BatchReceiptProcessResponseSchema>;
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
export type MealCheckinStatus = z.infer<typeof MealCheckinStatusSchema>;
export type MealCheckinOutcome = z.infer<typeof MealCheckinOutcomeSchema>;
export type MealCheckinLine = z.infer<typeof MealCheckinLineSchema>;
export type MealCheckin = z.infer<typeof MealCheckinSchema>;
export type MealCheckinPendingResponse = z.infer<typeof MealCheckinPendingResponseSchema>;
export type MealCheckinSubmitRequest = z.infer<typeof MealCheckinSubmitRequestSchema>;
export type MealCheckinSubmitResponse = z.infer<typeof MealCheckinSubmitResponseSchema>;
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
export type ShoppingDraftStatus = z.infer<typeof ShoppingDraftStatusSchema>;
export type ShoppingDraftItemStatus = z.infer<typeof ShoppingDraftItemStatusSchema>;
export type ShoppingDraftItem = z.infer<typeof ShoppingDraftItemSchema>;
export type ShoppingDraft = z.infer<typeof ShoppingDraftSchema>;
export type ShoppingDraftGenerateRequest = z.infer<typeof ShoppingDraftGenerateRequestSchema>;
export type ShoppingDraftPatchItem = z.infer<typeof ShoppingDraftPatchItemSchema>;
export type ShoppingDraftPatchRequest = z.infer<typeof ShoppingDraftPatchRequestSchema>;
export type ShoppingDraftResponse = z.infer<typeof ShoppingDraftResponseSchema>;
export type PantryHealthSubscores = z.infer<typeof PantryHealthSubscoresSchema>;
export type PantryHealthScore = z.infer<typeof PantryHealthScoreSchema>;
export type PantryHealthHistoryResponse = z.infer<typeof PantryHealthHistoryResponseSchema>;
export type RecommendationFeedbackRequest = z.infer<typeof RecommendationFeedbackRequestSchema>;
export type RecommendationFeedbackRecord = z.infer<typeof RecommendationFeedbackRecordSchema>;
export type RecommendationFeedbackResponse = z.infer<typeof RecommendationFeedbackResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
