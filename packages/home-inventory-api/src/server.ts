import { createApp } from "./app.js";
import { readApiConfigFromEnv } from "./config/env.js";
import { InMemoryJobStore } from "./storage/in-memory-job-store.js";

async function main() {
  const config = readApiConfigFromEnv();
  const store = new InMemoryJobStore({ uploadOrigin: config.uploadOrigin });
  const app = createApp({ config, store });

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[home-inventory-api] listening on :${config.port}`);
  });
}

void main();
