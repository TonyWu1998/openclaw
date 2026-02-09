import type { Express } from "express";
import {
  BatchReceiptProcessRequestSchema,
  BatchReceiptProcessResponseSchema,
  ClaimJobResponseSchema,
  CompleteJobRequestSchema,
  DailyRecommendationsResponseSchema,
  EnqueueJobResponseSchema,
  ExpiryRiskResponseSchema,
  FailJobRequestSchema,
  GenerateDailyRecommendationsRequestSchema,
  GenerateWeeklyRecommendationsRequestSchema,
  HealthResponseSchema,
  InventorySnapshotResponseSchema,
  JobResultRequestSchema,
  JobResultResponseSchema,
  JobStatusResponseSchema,
  LotExpiryOverrideRequestSchema,
  LotExpiryOverrideResponseSchema,
  ManualInventoryEntryRequestSchema,
  ManualInventoryEntryResponseSchema,
  MealCheckinPendingResponseSchema,
  MealCheckinSubmitRequestSchema,
  MealCheckinSubmitResponseSchema,
  RecommendationFeedbackRequestSchema,
  RecommendationFeedbackResponseSchema,
  ReceiptDetailsResponseSchema,
  ReceiptProcessRequestSchema,
  ReceiptReviewRequestSchema,
  ReceiptReviewResponseSchema,
  ReceiptUploadRequestSchema,
  ReceiptUploadResponseSchema,
  WeeklyRecommendationsResponseSchema,
  type HealthResponse,
} from "@openclaw/home-inventory-contracts";
import express from "express";
import type { ApiConfig } from "./config/env.js";
import type { ReceiptJobStore } from "./types/job-store.js";
import { parseBody, parseParam, requireWorkerToken } from "./routes/http-utils.js";

type CreateAppParams = {
  config: ApiConfig;
  store: ReceiptJobStore;
};

export function createApp(params: CreateAppParams): Express {
  const app = express();
  // Batch receipt process can carry multiple inline image payloads.
  app.use(express.json({ limit: "40mb" }));

  app.get("/health", (_req, res) => {
    const payload: HealthResponse = {
      ok: true,
      service: "home-inventory-api",
      now: new Date().toISOString(),
    };
    HealthResponseSchema.parse(payload);
    res.json(payload);
  });

  app.post("/v1/receipts/upload-url", (req, res) => {
    const body = parseBody(ReceiptUploadRequestSchema, req, res);
    if (!body) {
      return;
    }
    const response = params.store.createUpload(body);
    res.status(201).json(ReceiptUploadResponseSchema.parse(response));
  });

  app.get("/v1/receipts/:receiptUploadId", (req, res) => {
    const receiptUploadId = parseParam(req.params.receiptUploadId, "receiptUploadId", res);
    if (!receiptUploadId) {
      return;
    }

    const receipt = params.store.getReceipt(receiptUploadId);
    if (!receipt) {
      res
        .status(404)
        .json({ error: "not_found", message: `receipt not found: ${receiptUploadId}` });
      return;
    }

    res.json(ReceiptDetailsResponseSchema.parse(receipt));
  });

  app.put("/v1/receipts/:receiptUploadId/review", (req, res) => {
    const receiptUploadId = parseParam(req.params.receiptUploadId, "receiptUploadId", res);
    if (!receiptUploadId) {
      return;
    }

    const body = parseBody(ReceiptReviewRequestSchema, req, res);
    if (!body) {
      return;
    }

    const reviewed = params.store.reviewReceipt(receiptUploadId, body);
    if (!reviewed) {
      res
        .status(404)
        .json({ error: "not_found", message: `receipt not found: ${receiptUploadId}` });
      return;
    }

    res.json(ReceiptReviewResponseSchema.parse(reviewed));
  });

  app.post("/v1/receipts/batch/process", (req, res) => {
    const body = parseBody(BatchReceiptProcessRequestSchema, req, res);
    if (!body) {
      return;
    }

    const response = params.store.enqueueBatchJobs(body);
    const status = response.accepted > 0 ? 202 : 400;
    res.status(status).json(BatchReceiptProcessResponseSchema.parse(response));
  });

  app.post("/v1/receipts/:receiptUploadId/process", (req, res) => {
    const receiptUploadId = parseParam(req.params.receiptUploadId, "receiptUploadId", res);
    if (!receiptUploadId) {
      return;
    }

    const body = parseBody(ReceiptProcessRequestSchema, req, res);
    if (!body) {
      return;
    }

    try {
      const job = params.store.enqueueJob({
        householdId: body.householdId,
        receiptUploadId,
        request: body,
      });
      res.status(202).json(EnqueueJobResponseSchema.parse({ job }));
    } catch (error) {
      res.status(404).json({ error: "not_found", message: String(error) });
    }
  });

  app.get("/v1/jobs/:jobId", (req, res) => {
    const jobId = parseParam(req.params.jobId, "jobId", res);
    if (!jobId) {
      return;
    }
    const job = params.store.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: "not_found", message: `job not found: ${jobId}` });
      return;
    }
    res.json(JobStatusResponseSchema.parse({ job }));
  });

  app.get("/v1/inventory/:householdId", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const snapshot = params.store.getInventory(householdId);
    res.json(InventorySnapshotResponseSchema.parse(snapshot));
  });

  app.post("/v1/inventory/:householdId/manual-items", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const body = parseBody(ManualInventoryEntryRequestSchema, req, res);
    if (!body) {
      return;
    }

    const result = params.store.addManualItems(householdId, body);
    res.status(201).json(ManualInventoryEntryResponseSchema.parse(result));
  });

  app.post("/v1/inventory/:householdId/lots/:lotId/expiry", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    const lotId = parseParam(req.params.lotId, "lotId", res);
    if (!householdId || !lotId) {
      return;
    }

    const body = parseBody(LotExpiryOverrideRequestSchema, req, res);
    if (!body) {
      return;
    }

    if (body.householdId !== householdId) {
      res.status(400).json({
        error: "invalid_request",
        message: "householdId in body must match householdId path parameter",
      });
      return;
    }

    const result = params.store.overrideLotExpiry(householdId, lotId, body);
    if (!result) {
      res.status(404).json({ error: "not_found", message: `lot not found: ${lotId}` });
      return;
    }

    res.json(LotExpiryOverrideResponseSchema.parse(result));
  });

  app.get("/v1/inventory/:householdId/expiry-risk", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const response = params.store.getExpiryRisk(householdId);
    res.json(ExpiryRiskResponseSchema.parse(response));
  });

  app.get("/v1/checkins/:householdId/pending", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const response = params.store.listPendingCheckins(householdId);
    res.json(MealCheckinPendingResponseSchema.parse(response));
  });

  app.post("/v1/checkins/:checkinId/submit", (req, res) => {
    const checkinId = parseParam(req.params.checkinId, "checkinId", res);
    if (!checkinId) {
      return;
    }

    const body = parseBody(MealCheckinSubmitRequestSchema, req, res);
    if (!body) {
      return;
    }

    const response = params.store.submitMealCheckin(checkinId, body);
    if (!response) {
      res.status(404).json({ error: "not_found", message: `checkin not found: ${checkinId}` });
      return;
    }

    res.json(MealCheckinSubmitResponseSchema.parse(response));
  });

  app.get("/v1/recommendations/:householdId/daily", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const recommendations = params.store.getDailyRecommendations(householdId);
    if (!recommendations) {
      res.status(404).json({
        error: "not_found",
        message: `daily recommendations not found for household: ${householdId}`,
      });
      return;
    }

    res.json(DailyRecommendationsResponseSchema.parse(recommendations));
  });

  app.post("/v1/recommendations/:householdId/daily/generate", async (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const body = parseBody(GenerateDailyRecommendationsRequestSchema, req, res);
    if (!body) {
      return;
    }

    const generated = await params.store.generateDailyRecommendations(householdId, body);
    res.json(DailyRecommendationsResponseSchema.parse(generated));
  });

  app.get("/v1/recommendations/:householdId/weekly", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const recommendations = params.store.getWeeklyRecommendations(householdId);
    if (!recommendations) {
      res.status(404).json({
        error: "not_found",
        message: `weekly recommendations not found for household: ${householdId}`,
      });
      return;
    }

    res.json(WeeklyRecommendationsResponseSchema.parse(recommendations));
  });

  app.post("/v1/recommendations/:householdId/weekly/generate", async (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const body = parseBody(GenerateWeeklyRecommendationsRequestSchema, req, res);
    if (!body) {
      return;
    }

    const generated = await params.store.generateWeeklyRecommendations(householdId, body);
    res.json(WeeklyRecommendationsResponseSchema.parse(generated));
  });

  app.post("/v1/recommendations/:recommendationId/feedback", (req, res) => {
    const recommendationId = parseParam(req.params.recommendationId, "recommendationId", res);
    if (!recommendationId) {
      return;
    }

    const body = parseBody(RecommendationFeedbackRequestSchema, req, res);
    if (!body) {
      return;
    }

    const feedback = params.store.recordRecommendationFeedback(recommendationId, body);
    if (!feedback) {
      res.status(404).json({
        error: "not_found",
        message: `recommendation not found: ${recommendationId}`,
      });
      return;
    }

    res.json(RecommendationFeedbackResponseSchema.parse({ feedback }));
  });

  app.post("/internal/jobs/claim", (req, res) => {
    if (!requireWorkerToken(req, res, params.config.workerToken)) {
      return;
    }

    const claimed = params.store.claimNextJob();
    res.json(ClaimJobResponseSchema.parse({ job: claimed }));
  });

  app.post("/internal/jobs/:jobId/result", (req, res) => {
    if (!requireWorkerToken(req, res, params.config.workerToken)) {
      return;
    }
    const jobId = parseParam(req.params.jobId, "jobId", res);
    if (!jobId) {
      return;
    }

    const body = parseBody(JobResultRequestSchema, req, res);
    if (!body) {
      return;
    }

    const result = params.store.submitJobResult(jobId, body);
    if (!result) {
      res.status(404).json({ error: "not_found", message: `job not found: ${jobId}` });
      return;
    }

    res.json(JobResultResponseSchema.parse(result));
  });

  app.post("/internal/jobs/:jobId/complete", (req, res) => {
    if (!requireWorkerToken(req, res, params.config.workerToken)) {
      return;
    }
    const jobId = parseParam(req.params.jobId, "jobId", res);
    if (!jobId) {
      return;
    }

    const body = parseBody(CompleteJobRequestSchema, req, res);
    if (!body) {
      return;
    }

    const job = params.store.completeJob(jobId, body.notes);
    if (!job) {
      res.status(404).json({ error: "not_found", message: `job not found: ${jobId}` });
      return;
    }
    res.json({ job });
  });

  app.post("/internal/jobs/:jobId/fail", (req, res) => {
    if (!requireWorkerToken(req, res, params.config.workerToken)) {
      return;
    }
    const jobId = parseParam(req.params.jobId, "jobId", res);
    if (!jobId) {
      return;
    }

    const body = parseBody(FailJobRequestSchema, req, res);
    if (!body) {
      return;
    }

    const job = params.store.failJob(jobId, body.error);
    if (!job) {
      res.status(404).json({ error: "not_found", message: `job not found: ${jobId}` });
      return;
    }

    res.json({ job });
  });

  return app;
}
