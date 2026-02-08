import type { ReceiptProcessJob, ReceiptUploadRequest, ReceiptUploadResponse } from "@openclaw/home-inventory-contracts";

export type ReceiptUploadRecord = {
  receiptUploadId: string;
  householdId: string;
  filename: string;
  contentType: string;
  path: string;
  createdAt: string;
};

export type ReceiptJobStore = {
  createUpload: (request: ReceiptUploadRequest) => ReceiptUploadResponse;
  enqueueJob: (params: { householdId: string; receiptUploadId: string }) => ReceiptProcessJob;
  getJob: (jobId: string) => ReceiptProcessJob | null;
  claimNextJob: () => ReceiptProcessJob | null;
  completeJob: (jobId: string, notes?: string) => ReceiptProcessJob | null;
  failJob: (jobId: string, error: string) => ReceiptProcessJob | null;
};
