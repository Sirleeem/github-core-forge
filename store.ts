// The forge's store: every object, ref, issue, pull request and comment lives
// in memory in this process. Timestamps are fixed, never read from the wall
// clock, so a live run and its replay produce byte-identical exports.

import { buildCommit, buildTree, flattenTree, hashObject, parseCommit, type FileEntry, type GitObject, type ObjType } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const DEFAULT_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

/** Parse MAKEFUN_TRIAL_NOW the way the suite defines it: a number is epoch seconds, anything else goes through Date.parse. */
export function parseFixedEpoch(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_EPOCH;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_EPOCH;
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isFinite(value)) return Math.floor(value);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return DEFAULT_EPOCH;
}

export const FIXED_EPOCH = parseFixedEpoch(process.env.MAKEFUN_TRIAL_NOW);
export const FIXED_ISO = new Date(FIXED_EPOCH * 1000).toISOString();
export const FIXED_IDENT = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;

export function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    avatar_url: `https://avatars.example.invalid/u/${VIEWER_ID}`,
    gravatar_id: '',
    url: `https://api.example.invalid/users/${VIEWER_LOGIN}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  /** The issue or pull request number this comment belongs to. */
  subject: number;
  kind: 'issue' | 'pull';
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  nextNumber: number;
  nextCommentId: number;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  comments: Comment[];
  createdSeq: number;
}

let repoCounter = 0;
let sequenceCounter = 0;

export function nextSequence(): number {
  sequenceCounter += 1;
  return sequenceCounter;
}

/** Create an empty repository record. */
export function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  repoCounter += 1;
  return {
    id: repoCounter,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: [],
    createdSeq: nextSequence(),
  };
}

const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

/** Repositories owned by the viewer, in creation order. */
export function listRepos(): Repo[] {
  return [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
}

export function addRepo(repo: Repo): void {
  repos.set(repoKey(repo.owner, repo.name), repo);
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

/** Store an object, returning its id. Identical objects are stored once. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function lookupObject(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** The ref the default branch points to, if it has a commit. */
export function defaultBranchRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Resolve a ref name (branch, full ref or oid) to a commit oid, or null. */
export function resolveRefToCommit(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(defaultBranchRefName(repo)) ?? null;
  const lookup = lookupObject(repo);
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid === undefined) continue;
    const object = lookup(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const seen = new Set<string>();
      let current = oid;
      while (!seen.has(current)) {
        seen.add(current);
        const tagObject = lookup(current);
        if (tagObject === undefined || tagObject.type !== 'tag') break;
        const header = tagObject.data.toString('utf8').split('\n\n')[0];
        const match = /^object ([0-9a-f]{40})$/m.exec(header);
        if (match === null) break;
        current = match[1];
      }
      const target = lookup(current);
      return target !== undefined && target.type === 'commit' ? current : null;
    }
    return null;
  }
  const direct = lookup(ref);
  return direct !== undefined && direct.type === 'commit' ? ref : null;
}

/** Resolve a ref name to the object it points to (tag objects are NOT peeled). */
export function resolveRefToObject(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(defaultBranchRefName(repo)) ?? null;
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return oid;
  }
  return repo.objects.has(ref) ? ref : null;
}

// ---------------------------------------------------------------------------
// commits made by the server itself (contents API, merges)
// ---------------------------------------------------------------------------

/** Create a commit on top of `parents` with the viewer's identity and the fixed timestamp. */
export function makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const data = buildCommit({ tree, parents, author: FIXED_IDENT, committer: FIXED_IDENT, message });
  return putObject(repo, 'commit', data);
}

/** The empty tree object, stored in the repo. */
export function emptyTreeOid(repo: Repo): string {
  return putObject(repo, 'tree', buildTree([]));
}

/** The flattened file map at a commit, or an empty map for an unborn history. */
export function treeAtCommit(repo: Repo, commitOid: string | null): Map<string, FileEntry> {
  if (commitOid === null) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(lookupObject(repo), parseCommit(object.data).tree);
}

// ---------------------------------------------------------------------------
// global ids (GraphQL node ids / mutation inputs)
// ---------------------------------------------------------------------------

const GLOBAL_ID_PREFIX = 'forge:v1:';

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`${GLOBAL_ID_PREFIX}repo:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`${GLOBAL_ID_PREFIX}issue:${repo.owner}/${repo.name}#${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`${GLOBAL_ID_PREFIX}pull:${repo.owner}/${repo.name}#${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, number: number, commentId: number): string {
  return Buffer.from(`${GLOBAL_ID_PREFIX}comment:${repo.owner}/${repo.name}#${number}:${commentId}`, 'utf8').toString('base64');
}

export type DecodedGlobalId =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issue' | 'pull'; owner: string; name: string; number: number }
  | { kind: 'comment'; owner: string; name: string; number: number; commentId: number };

/** Decode a global id; returns null for anything that is not one of ours. */
export function decodeGlobalId(id: string): DecodedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith(GLOBAL_ID_PREFIX)) return null;
  const rest = text.slice(GLOBAL_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const kind = rest.slice(0, colon);
  const payload = rest.slice(colon + 1);
  if (kind === 'repo') {
    const slash = payload.indexOf('/');
    if (slash < 0) return null;
    return { kind: 'repo', owner: payload.slice(0, slash), name: payload.slice(slash + 1) };
  }
  if (kind === 'issue' || kind === 'pull') {
    const hash = payload.indexOf('#');
    if (hash < 0) return null;
    const number = Number(payload.slice(hash + 1));
    if (!Number.isInteger(number) || number < 1) return null;
    const slash = payload.indexOf('/');
    if (slash < 0 || slash > hash) return null;
    return { kind, owner: payload.slice(0, slash), name: payload.slice(slash + 1, hash), number };
  }
  if (kind === 'comment') {
    const hash = payload.indexOf('#');
    const colon2 = payload.indexOf(':', hash);
    if (hash < 0 || colon2 < 0) return null;
    const number = Number(payload.slice(hash + 1, colon2));
    const commentId = Number(payload.slice(colon2 + 1));
    if (!Number.isInteger(number) || number < 1 || !Number.isInteger(commentId) || commentId < 1) return null;
    const slash = payload.indexOf('/');
    if (slash < 0 || slash > hash) return null;
    return { kind: 'comment', owner: payload.slice(0, slash), name: payload.slice(slash + 1, hash), number, commentId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// renderers: the shapes the REST, GraphQL and MCP surfaces share
// ---------------------------------------------------------------------------

export function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length + [...repo.pulls.values()].filter((pr) => pr.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelObjects(repo: Repo, names: readonly string[]): Array<Record<string, unknown>> {
  return names.map((name) => {
    const label = repo.labels.get(name);
    return { id: 0, node_id: '', name, color: label?.color ?? 'ededed', description: null, url: '' };
  });
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: issueGlobalId(repo, issue.number),
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObject(),
    labels: labelObjects(repo, issue.labels),
    locked: false,
    assignees: [],
    milestone: null,
    comments: repo.comments.filter((comment) => comment.kind === 'issue' && comment.subject === issue.number).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

/** A pull request rendered as an issue object, the way GitHub's issues API renders one. */
export function pullAsIssueObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const rendered = issueObject(repo, { number: pr.number, title: pr.title, body: pr.body, state: pr.state, labels: [], createdSeq: pr.createdSeq });
  rendered.pull_request = {
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    merged_at: pr.mergedAt,
  };
  rendered.comments = repo.comments.filter((comment) => comment.kind === 'pull' && comment.subject === pr.number).length;
  rendered.node_id = pullGlobalId(repo, pr.number);
  return rendered;
}

export function pullObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.number,
    node_id: pullGlobalId(repo, pr.number),
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: userObject(),
    body: pr.body,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pr.state === 'closed' ? FIXED_ISO : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    review_comments_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`,
    review_comment_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments`,
    statuses_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/statuses/${pr.headSha}`,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      user: userObject(),
      repo: repoObject(repo),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      user: userObject(),
      repo: repoObject(repo),
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? true : null,
    rebaseable: null,
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    merged_by: pr.merged ? userObject() : null,
    comments: repo.comments.filter((comment) => comment.kind === 'pull' && comment.subject === pr.number).length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

export function commentObject(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, comment.subject, comment.id),
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${comment.subject}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObject(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    issue_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/issues/${comment.subject}`,
    author_association: 'OWNER',
  };
}
