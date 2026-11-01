// End-to-end smoke tests. Starts the backend (serving the built UI) with a throw-away data dir.
// Usage: npm run build && npm run e2e      (first time: npx playwright install chromium)
import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.QES_E2E_PORT ?? 8799);
const home = process.env.QES_E2E_HOME ?? path.join(os.tmpdir(), `qes-e2e-${process.pid}`);
const python = process.env.QES_PYTHON ?? 'python3';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: `${python} -m qestudio.cli --no-browser --port ${port}`,
    cwd: '../backend',
    env: { QES_HOME: home, QES_NO_KEYRING: '1' },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
