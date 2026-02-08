import {
  ClaimJobResponseSchema,
  FailJobRequestSchema,
  JobResultRequestSchema,
  type ClaimedJob,
  type JobResultRequest,
} from "@openclaw/home-inventory-contracts";

export type WorkerApiClient = {
  claimJob: () => Promise<ClaimedJob | null>;
  submitJobResult: (jobId: string, result: JobResultRequest) => Promise<void>;
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

  async claimJob(): Promise<ClaimedJob | null> {
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

  async submitJobResult(jobId: string, result: JobResultRequest): Promise<void> {
    const body = JobResultRequestSchema.parse(result);
    const response = await fetch(`${this.baseUrl}/internal/jobs/${jobId}/result`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`failed to submit result for job ${jobId}: ${response.status}`);
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
