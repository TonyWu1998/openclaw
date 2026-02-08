import {
  ClaimJobResponseSchema,
  FailJobRequestSchema,
  type ReceiptProcessJob,
} from "@openclaw/home-inventory-contracts";

export type WorkerApiClient = {
  claimJob: () => Promise<ReceiptProcessJob | null>;
  completeJob: (jobId: string, notes?: string) => Promise<void>;
  failJob: (jobId: string, error: string) => Promise<void>;
};

export type HttpWorkerApiClientOptions = {
  baseUrl: string;
  workerToken: string;
};

export class HttpWorkerApiClient implements WorkerApiClient {
  private readonly baseUrl: string;
  private readonly workerToken: string;

  constructor(options: HttpWorkerApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.workerToken = options.workerToken;
  }

  async claimJob(): Promise<ReceiptProcessJob | null> {
    const response = await fetch(`${this.baseUrl}/internal/jobs/claim`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`failed to claim job: ${response.status}`);
    }

    const payload = await response.json();
    return ClaimJobResponseSchema.parse(payload).job;
  }

  async completeJob(jobId: string, notes?: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/internal/jobs/${jobId}/complete`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ notes }),
    });

    if (!response.ok) {
      throw new Error(`failed to complete job ${jobId}: ${response.status}`);
    }
  }

  async failJob(jobId: string, error: string): Promise<void> {
    const body = FailJobRequestSchema.parse({ error });
    const response = await fetch(`${this.baseUrl}/internal/jobs/${jobId}/fail`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`failed to fail job ${jobId}: ${response.status}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-home-inventory-worker-token": this.workerToken,
    };
  }
}
