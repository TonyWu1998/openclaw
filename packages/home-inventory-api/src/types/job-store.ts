import type {
  ClaimedJob,
  InventorySnapshotResponse,
  JobResultRequest,
  ReceiptDetailsResponse,
  ReceiptProcessJob,
  ReceiptProcessRequest,
  ReceiptUploadRequest,
  ReceiptUploadResponse,
} from "@openclaw/home-inventory-contracts";

export type ReceiptJobStore = {
  createUpload: (request: ReceiptUploadRequest) => ReceiptUploadResponse;
  enqueueJob: (params: {
    householdId: string;
    receiptUploadId: string;
    request: ReceiptProcessRequest;
  }) => ReceiptProcessJob;
  getJob: (jobId: string) => ReceiptProcessJob | null;
  getReceipt: (receiptUploadId: string) => ReceiptDetailsResponse | null;
  claimNextJob: () => ClaimedJob | null;
  submitJobResult: (jobId: string, result: JobResultRequest) => {
    job: ReceiptProcessJob;
    receipt: ReceiptDetailsResponse["receipt"];
  } | null;
  completeJob: (jobId: string, notes?: string) => ReceiptProcessJob | null;
  failJob: (jobId: string, error: string) => ReceiptProcessJob | null;
  getInventory: (householdId: string) => InventorySnapshotResponse;
};
