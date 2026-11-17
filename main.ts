// Entrypoint: bind an ephemeral port, register it with the harness, serve
// until the harness says the trial is done, then exit 0. The server itself
// lives in app.ts; this file owns only the harness lifecycle.

import { startServer } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const BASE_URL = envUrl.replace(/\/$/, '');
const INITIAL_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST the listening port to /register, retrying with exponential backoff. */
async function register(port: number): Promise<void> {
  let delay = INITIAL_DELAY_MS;
  for (;;) {
    let response: Response | null = null;
    try {
      response = await fetch(`${BASE_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      response = null;
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        console.error(`register failed with ${response.status}`);
        process.exit(1);
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/** Poll /done until the harness reports the trial finished. Never exits early. */
async function waitForDone(): Promise<void> {
  let delay = INITIAL_DELAY_MS;
  for (;;) {
    let done = false;
    let ok = false;
    try {
      const response = await fetch(`${BASE_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 200) {
        ok = true;
        const payload = (await response.json()) as { done?: unknown };
        done = payload.done === true;
      }
    } catch {
      ok = false;
    }
    if (done) return;
    await sleep(ok ? INITIAL_DELAY_MS : delay);
    delay = ok ? INITIAL_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);
  }
}

const server = await startServer(0);
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
if (port === 0) {
  console.error('server did not bind a port');
  process.exit(1);
}
await register(port);
await waitForDone();
server.close();
server.closeAllConnections();
process.exit(0);
