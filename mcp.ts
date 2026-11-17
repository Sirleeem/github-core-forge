// The MCP surface: JSON-RPC 2.0 over Streamable HTTP, answering plain JSON.
// Both the modern era (server/discover, no session) and the legacy
// initialize handshake are supported. The six tools act on the same store
// as the REST and GraphQL surfaces.

import { ApiError, createIssue, createPull, mergePull } from './rest.ts';
import {
  addRepo,
  createRepoRecord,
  getRepo,
  issueObject,
  pullObject,
  repoObject,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The tool list is built once at startup: two tools/list calls must answer
 * byte-identically, and a frozen constant guarantees it.
 */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') throw new RpcError(-32602, `Missing or invalid argument: ${field}`);
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcError(-32602, `Invalid argument: ${field} must be a string`);
  return value;
}

function requireRepo(args: Record<string, unknown>): Repo {
  const owner = requireString(args, 'owner');
  const name = requireString(args, 'repo');
  if (owner !== VIEWER_LOGIN) throw new ApiError(404, 'Repository not found');
  const repo = getRepo(owner, name);
  if (repo === undefined) throw new ApiError(404, 'Repository not found');
  return repo;
}

function callTool(name: string, args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new RpcError(-32602, 'Tool arguments must be an object');
  }
  const input = args as Record<string, unknown>;
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(input, 'name');
      if (getRepo(VIEWER_LOGIN, repoName) !== undefined) throw new ApiError(422, 'name already exists on this account');
      const description = optionalString(input, 'description') ?? '';
      const isPrivate = input.private === undefined ? false : input.private === true;
      const repo = createRepoRecord(repoName, description, isPrivate);
      addRepo(repo);
      return repoObject(repo);
    }
    case 'get_repo': {
      return repoObject(requireRepo(input));
    }
    case 'create_issue': {
      const repo = requireRepo(input);
      const title = requireString(input, 'title');
      const body = optionalString(input, 'body') ?? '';
      return issueObject(repo, createIssue(repo, title, body, []));
    }
    case 'list_issues': {
      const repo = requireRepo(input);
      const state = optionalString(input, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return issues.map((issue) => issueObject(repo, issue));
    }
    case 'create_pull_request': {
      const repo = requireRepo(input);
      const title = requireString(input, 'title');
      const head = requireString(input, 'head');
      const base = requireString(input, 'base');
      const body = optionalString(input, 'body') ?? '';
      return pullObject(repo, createPull(repo, title, body, head, base));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(input);
      const raw = input.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      if (!Number.isInteger(number) || number < 1) throw new RpcError(-32602, 'Missing or invalid argument: pull_number');
      const pr = repo.pulls.get(number);
      if (pr === undefined) throw new ApiError(404, 'Pull request not found');
      const { sha } = mergePull(repo, pr, 'squash');
      return { sha, merged: true, message: 'Pull Request successfully merged' };
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export interface McpReply {
  status: number;
  json?: unknown;
}

type JsonRpcId = string | number | null;

function success(id: JsonRpcId, result: unknown): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function failure(id: JsonRpcId, code: number, message: string): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Handle one MCP request body. Authentication is checked by the caller, before parsing. */
export function handleMcp(bodyText: string): McpReply {
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return failure(null, -32600, 'Invalid Request');
  }
  const message = request as Record<string, unknown>;
  const method = message.method;
  const hasId = message.id !== undefined;
  const id = (message.id as JsonRpcId | undefined) ?? null;
  if (typeof method !== 'string') {
    if (!hasId) return { status: 202 };
    return failure(id, -32600, 'Invalid Request');
  }
  // Notifications (no id) are acknowledged with 202 and an empty body.
  if (!hasId) return { status: 202 };
  if (method === 'server/discover') {
    return success(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
    const offered = params.protocolVersion;
    const version = typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return success(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return success(id, {});
  if (method === 'tools/list') {
    return success(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') return failure(id, -32602, 'Missing tool name');
    try {
      return success(id, toolResult(callTool(toolName, params.arguments ?? {})));
    } catch (err) {
      if (err instanceof RpcError) return failure(id, err.code, err.message);
      if (err instanceof ApiError) return success(id, toolError(err.message));
      return success(id, toolError(err instanceof Error ? err.message : 'Tool call failed'));
    }
  }
  return failure(id, -32601, `Method not found: ${method}`);
}
