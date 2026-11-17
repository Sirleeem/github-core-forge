// The HTTP server: routing, bearer authentication, the JSON envelope and the
// headers every response carries. Transport only; the surfaces live in
// rest.ts, graphql.ts, mcp.ts and githttp.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { ApiError, routeRest } from './rest.ts';
import { getRepo } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

const EMPTY_QUERY = new URLSearchParams();

interface Route {
  segments: string[];
  query: URLSearchParams;
  rawPath: string;
}

function parseRoute(url: string | undefined): Route {
  const raw = url ?? '/';
  const question = raw.indexOf('?');
  const rawPath = question < 0 ? raw : raw.slice(0, question);
  const rawQuery = question < 0 ? '' : raw.slice(question + 1);
  const segments = rawPath
    .split('/')
    .slice(1)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  // A trailing slash adds an empty segment; drop it so /api/v3 and /api/v3/ match.
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  return { segments, query: rawQuery === '' ? EMPTY_QUERY : new URLSearchParams(rawQuery), rawPath };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new ApiError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string, extra: Record<string, string>): void {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string, extra: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  const { segments, query } = parseRoute(req.url);
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  try {
    // /healthz is exempt from authentication.
    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(res, 200, { ok: true }, requestId, {});
      return;
    }
    const isRestRoot = method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3';
    const authorized = TOKEN === '' || req.headers.authorization === `Bearer ${TOKEN}`;
    if (!authorized && !isRestRoot) {
      sendJson(res, 401, { message: 'Bad credentials' }, requestId, {});
      return;
    }

    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      const restSegments = segments.slice(2);
      const body = await readBody(req);
      let parsed: unknown;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON in request body' }, requestId, scopes);
          return;
        }
      }
      try {
        const reply = routeRest(method, restSegments, query, parsed, req.headers.host ?? 'localhost');
        if (reply.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId, ...scopes });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.json ?? {}, requestId, { ...scopes, ...(reply.headers ?? {}) });
      } catch (err) {
        if (err instanceof ApiError) {
          sendJson(res, err.status, { message: err.message }, requestId, scopes);
          return;
        }
        throw err;
      }
      return;
    }

    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' }, requestId, {});
        return;
      }
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON in request body' }, requestId, {});
        return;
      }
      const reply = handleGraphQL(parsed);
      sendJson(res, reply.status, reply.json, requestId, {});
      return;
    }

    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' }, requestId, {});
        return;
      }
      const body = await readBody(req);
      const reply = handleMcp(body.toString('utf8'));
      if (reply.status === 202) {
        res.writeHead(202, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.json, requestId, {});
      return;
    }

    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1].slice(0, -4);
      const repo = getRepo(owner, repoName);
      const tail = segments.slice(2);
      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        const reply = handleInfoRefs(repo, repoName, query.get('service'), req.headers['git-protocol']);
        sendBuffer(res, reply.status, reply.contentType, reply.body, requestId, {});
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        const body = await readBody(req);
        const reply = handleUploadPack(repo, repoName, req.headers['git-protocol'], body);
        sendBuffer(res, reply.status, reply.contentType, reply.body, requestId, {});
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        const body = await readBody(req);
        const reply = handleReceivePack(repo, repoName, body);
        sendBuffer(res, reply.status, reply.contentType, reply.body, requestId, {});
        return;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId, {});
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId, {});
  } catch (err) {
    if (err instanceof ApiError) {
      if (!res.headersSent) sendJson(res, err.status, { message: err.message }, requestId, {});
      return;
    }
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId, {});
    else res.end();
  }
}

/** Start the server on `port` (0 = an ephemeral port) and resolve once listening. */
export function startServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}
