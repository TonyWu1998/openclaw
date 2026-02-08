import express from "express";
import type { Express } from "express";
import {
  ClaimJobResponseSchema,
  CompleteJobRequestSchema,
  EnqueueJobResponseSchema,
  FailJobRequestSchema,
  HealthResponseSchema,
  JobResultRequestSchema,
  JobResultResponseSchema,
  ReceiptDetailsResponseSchema,
  ReceiptProcessRequestSchema,
  ReceiptUploadRequestSchema,
  type HealthResponse,
} from "@openclaw/home-inventory-contracts";
import type { ApiConfig } from "./config/env.js";
import { parseBody, parseParam, requireWorkerToken } from "./routes/http-utils.js";
import type { ReceiptJobStore } from "./types/job-store.js";

type CreateAppParams = {
  config: ApiConfig;
  store: ReceiptJobStore;
};

export function createApp(params: CreateAppParams): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

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
    res.status(201).json(response);
  });

  app.get("/v1/receipts/:receiptUploadId", (req, res) => {
    const receiptUploadId = parseParam(req.params.receiptUploadId, "receiptUploadId", res);
    if (!receiptUploadId) {
      return;
    }

    const receipt = params.store.getReceipt(receiptUploadId);
    if (!receipt) {
      res.status(404).json({ error: "not_found", message: `receipt not found: ${receiptUploadId}` });
      return;
    }

    res.json(ReceiptDetailsResponseSchema.parse(receipt));
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
    res.json({ job });
  });

  app.get("/v1/inventory/:householdId", (req, res) => {
    const householdId = parseParam(req.params.householdId, "householdId", res);
    if (!householdId) {
      return;
    }

    const snapshot = params.store.getInventory(householdId);
    res.json(snapshot);
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
