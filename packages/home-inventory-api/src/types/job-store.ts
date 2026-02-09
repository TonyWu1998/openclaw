import type {
  BatchReceiptProcessRequest,
  BatchReceiptProcessResponse,
  ClaimedJob,
  DailyRecommendationsResponse,
  ExpiryRiskResponse,
  GenerateDailyRecommendationsRequest,
  GenerateWeeklyRecommendationsRequest,
  InventorySnapshotResponse,
  JobResultRequest,
  LotExpiryOverrideRequest,
  LotExpiryOverrideResponse,
  ManualInventoryEntryRequest,
  ManualInventoryEntryResponse,
  MealCheckinPendingResponse,
  MealCheckinSubmitRequest,
  MealCheckinSubmitResponse,
  RecommendationFeedbackRecord,
  RecommendationFeedbackRequest,
  ReceiptDetailsResponse,
  ReceiptProcessJob,
  ReceiptProcessRequest,
  ReceiptReviewRequest,
  ReceiptReviewResponse,
  ReceiptUploadRequest,
  ReceiptUploadResponse,
  WeeklyRecommendationsResponse,
} from "@openclaw/home-inventory-contracts";

export type ReceiptJobStore = {
  createUpload: (request: ReceiptUploadRequest) => ReceiptUploadResponse;
  enqueueJob: (params: {
    householdId: string;
    receiptUploadId: string;
    request: ReceiptProcessRequest;
  }) => ReceiptProcessJob;
  enqueueBatchJobs: (request: BatchReceiptProcessRequest) => BatchReceiptProcessResponse;
  getJob: (jobId: string) => ReceiptProcessJob | null;
  getReceipt: (receiptUploadId: string) => ReceiptDetailsResponse | null;
  reviewReceipt: (
    receiptUploadId: string,
    request: ReceiptReviewRequest,
  ) => ReceiptReviewResponse | null;
  claimNextJob: () => ClaimedJob | null;
  submitJobResult: (
    jobId: string,
    result: JobResultRequest,
  ) => {
    job: ReceiptProcessJob;
    receipt: ReceiptDetailsResponse["receipt"];
  } | null;
  completeJob: (jobId: string, notes?: string) => ReceiptProcessJob | null;
  failJob: (jobId: string, error: string) => ReceiptProcessJob | null;
  getInventory: (householdId: string) => InventorySnapshotResponse;
  addManualItems: (
    householdId: string,
    request: ManualInventoryEntryRequest,
  ) => ManualInventoryEntryResponse;
  overrideLotExpiry: (
    householdId: string,
    lotId: string,
    request: LotExpiryOverrideRequest,
  ) => LotExpiryOverrideResponse | null;
  getExpiryRisk: (householdId: string) => ExpiryRiskResponse;
  listPendingCheckins: (householdId: string) => MealCheckinPendingResponse;
  submitMealCheckin: (
    checkinId: string,
    request: MealCheckinSubmitRequest,
  ) => MealCheckinSubmitResponse | null;
  generateDailyRecommendations: (
    householdId: string,
    request: GenerateDailyRecommendationsRequest,
  ) => Promise<DailyRecommendationsResponse>;
  getDailyRecommendations: (householdId: string) => DailyRecommendationsResponse | null;
  generateWeeklyRecommendations: (
    householdId: string,
    request: GenerateWeeklyRecommendationsRequest,
  ) => Promise<WeeklyRecommendationsResponse>;
  getWeeklyRecommendations: (householdId: string) => WeeklyRecommendationsResponse | null;
  recordRecommendationFeedback: (
    recommendationId: string,
    request: RecommendationFeedbackRequest,
  ) => RecommendationFeedbackRecord | null;
};
