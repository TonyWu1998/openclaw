export type ApiConfig = {
  port: number;
  workerToken: string;
  uploadOrigin: string;
};

export function readApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const portRaw = env.HOME_INVENTORY_API_PORT ?? "8789";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid HOME_INVENTORY_API_PORT: ${portRaw}`);
  }

  return {
    port,
    workerToken: env.HOME_INVENTORY_WORKER_TOKEN ?? "phase1-worker-token",
    uploadOrigin: env.HOME_INVENTORY_UPLOAD_ORIGIN ?? "https://uploads.example.local",
  };
}
