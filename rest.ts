// The REST v3 surface, plus the domain operations the GraphQL and MCP
// surfaces share (issues, pull requests, merges, comments). Every handler
// answers JSON; errors are ApiError with a status and a message.

import {
  diffTrees,
  flattenTree,
  hashObject,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  threeWayMerge,
  treeFromMap,
  updateTreePath,
  ZERO_OID,
  type DiffEntry,
  type FileEntry,
  type ObjType,
} from './git.ts';
import {
  addRepo,
  commentObject,
  createRepoRecord,
  defaultBranchRefName,
  deleteRepo,
  FIXED_EPOCH,
  FIXED_IDENT,
  FIXED_ISO,
  getRepo,
  issueObject,
  listRepos,
  lookupObject,
  makeCommit,
  nextSequence,
  pullAsIssueObject,
  pullObject,
  repoObject,
  resolveRefToCommit,
  userObject,
  VIEWER_LOGIN,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RestReply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (what: string): ApiError => new ApiError(404, `${what} not found`);
const unprocessable = (message: string): ApiError => new ApiError(422, message);

/** A body must be a JSON object for the endpoints that take one. */
function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw unprocessable(`Field ${field} must be a string`);
  return value;
}

function boolField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw unprocessable(`Field ${field} must be a boolean`);
  return value;
}

function requireRepo(owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw notFound('Repository');
  const repo = getRepo(owner, name);
  if (repo === undefined) throw notFound('Repository');
  return repo;
}

/** Lightweight ref-name validation (the rules git enforces that matter here). */
function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length <= 5) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
  if (ref.includes('@{') || ref.includes(' ') || ref.includes('~') || ref.includes('^') || ref.includes(':')) return false;
  for (let index = 0; index < ref.length; index += 1) {
    if (ref.charCodeAt(index) < 0x20 || ref.charCodeAt(index) === 0x7f) return false;
  }
  return true;
}

function validBranchName(branch: string): boolean {
  return branch !== '' && branch !== 'HEAD' && validRefName(`refs/heads/${branch}`);
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

interface PageParams {
  perPage: number;
  page: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** Slice a list into a page and build the Link header when more pages follow. */
function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (page >= totalPages) return { page: slice, link: null };
  const origin = `http://${host}`;
  const next = `${origin}${path}?per_page=${perPage}&page=${page + 1}`;
  const last = `${origin}${path}?per_page=${perPage}&page=${totalPages}`;
  return { page: slice, link: `<${next}>; rel="next", <${last}>; rel="last"` };
}

// ---------------------------------------------------------------------------
// domain operations shared with GraphQL and MCP
// ---------------------------------------------------------------------------

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  if (title.trim() === '') throw unprocessable('Title is required');
  for (const label of labels) {
    if (!repo.labels.has(label)) throw unprocessable(`Label ${label} does not exist`);
  }
  const issue: Issue = { number: repo.nextNumber++, title, body, state: 'open', labels: [...labels], createdSeq: nextSequence() };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
  if (title.trim() === '') throw unprocessable('Title is required');
  if (head === '' || base === '') throw unprocessable('head and base branches are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) throw unprocessable(`Head branch ${head} does not exist`);
  if (baseSha === undefined) throw unprocessable(`Base branch ${base} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw unprocessable('A pull request already exists for these branches');
    }
  }
  const pr: PullRequest = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: nextSequence(),
  };
  repo.pulls.set(pr.number, pr);
  return pr;
}

export function addComment(repo: Repo, subject: number, kind: 'issue' | 'pull', body: string): Comment {
  if (body === '') throw unprocessable('Comment body is required');
  const comment: Comment = { id: repo.nextCommentId++, body, createdSeq: nextSequence(), subject, kind };
  repo.comments.push(comment);
  return comment;
}

/** The two tips a diff or merge works from: current branch tips, snapshots when a branch is gone. */
function pullTips(repo: Repo, pr: PullRequest): { headTip: string; baseTip: string } {
  return {
    headTip: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha,
    baseTip: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha,
  };
}

function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  try {
    return parseCommit(object.data).tree;
  } catch {
    return null;
  }
}

export function pullFiles(repo: Repo, pr: PullRequest): DiffEntry[] {
  const { headTip, baseTip } = pullTips(repo, pr);
  const lookup = lookupObject(repo);
  const base = mergeBase(lookup, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  return diffTrees(lookup, baseTree, commitTree(repo, headTip));
}

export function pullMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const { headTip, baseTip } = pullTips(repo, pr);
  const lookup = lookupObject(repo);
  const base = mergeBase(lookup, baseTip, headTip);
  const outcome = threeWayMerge(lookup, base === null ? null : commitTree(repo, base), commitTree(repo, baseTip), commitTree(repo, headTip));
  return outcome.merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** The linear history of `tip` after `base` (first-parent walk), oldest first. */
function linearCommitsAfter(repo: Repo, tip: string, base: string | null): string[] {
  const commits: string[] = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current !== null && current !== base && !seen.has(current)) {
    seen.add(current);
    commits.push(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      break;
    }
    current = parents[0] ?? null;
  }
  return commits.reverse();
}

/** Store an object in a repo, returning its id (identical objects stored once). */
function putObjectLocal(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function mergePullSquash(repo: Repo, pr: PullRequest, baseTip: string, headTip: string, twoParents: boolean): string {
  const lookup = lookupObject(repo);
  const base = mergeBase(lookup, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const outcome = threeWayMerge(lookup, baseTree, commitTree(repo, baseTip), commitTree(repo, headTip));
  if (outcome.merged === null) throw new ApiError(405, `Merge conflict in: ${outcome.conflicts.join(', ')}`);
  let tree: string;
  try {
    tree = treeFromMap((type, data) => putObjectLocal(repo, type, data), outcome.merged);
  } catch (err) {
    throw new ApiError(405, `Merge conflict: ${(err as Error).message}`);
  }
  const message = twoParents
    ? `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`
    : `${pr.title} (#${pr.number})\n`;
  const parents = twoParents ? [baseTip, headTip] : [baseTip];
  return makeCommit(repo, tree, parents, message);
}

function mergePullRebase(repo: Repo, pr: PullRequest, baseTip: string, headTip: string): string {
  const lookup = lookupObject(repo);
  const base = mergeBase(lookup, baseTip, headTip);
  const commits = linearCommitsAfter(repo, headTip, base);
  let currentTip = baseTip;
  let currentFiles = new Map<string, FileEntry>();
  const baseTree = commitTree(repo, baseTip);
  if (baseTree !== null) currentFiles = flattenTree(lookup, baseTree);
  for (const commitOid of commits) {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') throw new ApiError(405, 'Head history could not be replayed');
    const info = parseCommit(object.data);
    const parentTree = info.parents.length > 0 ? commitTree(repo, info.parents[0]) : null;
    const parentFiles = parentTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, parentTree);
    const commitFiles = flattenTree(lookup, info.tree);
    const paths = new Set<string>([...parentFiles.keys(), ...commitFiles.keys()]);
    const next = new Map(currentFiles);
    for (const path of paths) {
      const before = parentFiles.get(path);
      const after = commitFiles.get(path);
      const same = (a: FileEntry | undefined, b: FileEntry | undefined): boolean =>
        a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
      if (same(before, after)) continue;
      const current = next.get(path);
      if (!same(current, before) && !same(current, after)) {
        throw new ApiError(405, `Merge conflict in: ${path}`);
      }
      if (after === undefined) next.delete(path);
      else next.set(path, after);
    }
    let tree: string;
    try {
      tree = treeFromMap((type, data) => putObjectLocal(repo, type, data), next);
    } catch (err) {
      throw new ApiError(405, `Merge conflict: ${(err as Error).message}`);
    }
    const data = Buffer.from(
      `tree ${tree}\nparent ${currentTip}\nauthor ${info.author}\ncommitter ${FIXED_IDENT}\n\n${info.message}`,
      'utf8',
    );
    currentTip = putObjectLocal(repo, 'commit', data);
    currentFiles = next;
  }
  void pr;
  return currentTip;
}

export function mergePull(repo: Repo, pr: PullRequest, method: string): { sha: string } {
  if (pr.state !== 'open') throw new ApiError(405, 'Pull request is already closed');
  const normalized = method === '' ? 'squash' : method;
  if (normalized !== 'squash' && normalized !== 'merge' && normalized !== 'rebase') {
    throw new ApiError(405, `Unsupported merge method: ${method}`);
  }
  const { headTip, baseTip } = pullTips(repo, pr);
  const sha = normalized === 'rebase' ? mergePullRebase(repo, pr, baseTip, headTip) : mergePullSquash(repo, pr, baseTip, headTip, normalized === 'merge');
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = FIXED_ISO;
  pr.mergeCommitSha = sha;
  return { sha };
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

interface ResolvedContent {
  tree: string | null;
  commit: string | null;
}

/** Resolve a ?ref= (or the default branch) to its commit and tree. */
function resolveContentRef(repo: Repo, ref: string | null): ResolvedContent {
  const commit = ref === null || ref === '' ? repo.refs.get(defaultBranchRefName(repo)) ?? null : resolveRefToCommit(repo, ref);
  if (commit === null) return { tree: null, commit: null };
  return { tree: commitTree(repo, commit), commit };
}

function lookupPath(repo: Repo, treeOid: string, segments: readonly string[]): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  let current: string | null = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    if (current === null) return null;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    let entries;
    try {
      entries = parseTree(object.data);
    } catch {
      return null;
    }
    const entry = entries.find((item) => item.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function contentLinks(owner: string, name: string, path: string): Record<string, string> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return {
    git: `https://api.example.invalid/repos/${owner}/${name}/git/blobs/`,
    self: `https://api.example.invalid/repos/${owner}/${name}/contents/${encoded}`,
    html: `https://example.invalid/${owner}/${name}/blob/HEAD/${encoded}`,
  };
}

function fileObject(repo: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    git_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/HEAD/${path}`,
    _links: contentLinks(repo.owner, repo.name, path),
  };
}

function dirEntryObject(repo: Repo, path: string, name: string, oid: string, mode: string, size: number): Record<string, unknown> {
  const type = mode === '40000' ? 'dir' : 'file';
  return {
    type,
    size,
    name,
    path,
    sha: oid,
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    git_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/${type === 'dir' ? 'trees' : 'blobs'}/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/${type === 'dir' ? 'tree' : 'blob'}/HEAD/${path}`,
    download_url: type === 'dir' ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/HEAD/${path}`,
    _links: contentLinks(repo.owner, repo.name, path),
  };
}

// ---------------------------------------------------------------------------
// commits rendering
// ---------------------------------------------------------------------------

function parseIdent(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, epoch: FIXED_EPOCH };
  return { name: match[1], email: match[2], epoch: Number(match[3]) };
}

function commitObject(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  let info;
  try {
    info = parseCommit(object.data);
  } catch {
    return null;
  }
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const message = info.message.endsWith('\n') ? info.message.slice(0, -1) : info.message;
  return {
    sha,
    node_id: Buffer.from(`forge:v1:commit:${repo.owner}/${repo.name}#${sha}`, 'utf8').toString('base64'),
    commit: {
      author: { name: author.name, email: author.email, date: new Date(author.epoch * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.epoch * 1000).toISOString() },
      message,
      tree: { sha: info.tree, url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userObject(),
    committer: userObject(),
    parents: info.parents.map((parent) => ({ sha: parent, url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/commits/${parent}`, html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
}

function walkCommits(repo: Repo, tip: string, limit: number): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && order.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      continue;
    }
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
  }
  return order;
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

function handleRoot(): RestReply {
  return {
    status: 200,
    json: {
      current_user_url: 'https://api.example.invalid/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: 'https://api.example.invalid/authorizations',
      code_search_url: 'https://api.example.invalid/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: 'https://api.example.invalid/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: 'https://api.example.invalid/user/emails',
      emojis_url: 'https://api.example.invalid/emojis',
      events_url: 'https://api.example.invalid/events',
      feeds_url: 'https://api.example.invalid/feeds',
      followers_url: 'https://api.example.invalid/user/followers',
      following_url: 'https://api.example.invalid/user/following{/target}',
      gists_url: 'https://api.example.invalid/gists{/gist_id}',
      hub_url: 'https://api.example.invalid/hub',
      issue_search_url: 'https://api.example.invalid/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: 'https://api.example.invalid/issues',
      keys_url: 'https://api.example.invalid/user/keys',
      label_search_url: 'https://api.example.invalid/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: 'https://api.example.invalid/notifications',
      organization_repositories_url: 'https://api.example.invalid/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: 'https://api.example.invalid/orgs/{org}/teams',
      public_gists_url: 'https://api.example.invalid/gists/public',
      rate_limit_url: 'https://api.example.invalid/rate_limit',
      repository_url: 'https://api.example.invalid/repos/{owner}/{repo}',
      repository_search_url: 'https://api.example.invalid/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: 'https://api.example.invalid/user/repos{?type,page,per_page,sort}',
      starred_url: 'https://api.example.invalid/user/starred{/owner}{/repo}',
      starred_gists_url: 'https://api.example.invalid/gists/starred',
      user_url: 'https://api.example.invalid/users/{user}',
      user_organizations_url: 'https://api.example.invalid/user/orgs',
      user_repositories_url: 'https://api.example.invalid/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: 'https://api.example.invalid/search/users?q={query}{&page,per_page,sort,order}',
    },
  };
}

function handleCreateRepo(body: unknown): RestReply {
  const data = bodyObject(body);
  const name = stringField(data, 'name');
  if (name === undefined || name.trim() === '') throw unprocessable('Name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw unprocessable(`Invalid repository name: ${name}`);
  if (getRepo(VIEWER_LOGIN, name) !== undefined) throw unprocessable('name already exists on this account');
  const repo = createRepoRecord(name, stringField(data, 'description') ?? '', boolField(data, 'private', false));
  addRepo(repo);
  if (boolField(data, 'auto_init', false)) {
    const readme = putObjectLocal(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const tree = updateTreePath(lookupObject(repo), (type, data2) => putObjectLocal(repo, type, data2), null, ['README.md'], readme, '100644');
    const commit = makeCommit(repo, tree, [], `Initial commit\n`);
    repo.refs.set(defaultBranchRefName(repo), commit);
  }
  return { status: 201, json: repoObject(repo) };
}

function handleListUserRepos(query: URLSearchParams, host: string): RestReply {
  const repos = listRepos();
  const { page, link } = paginate(repos, query, '/api/v3/user/repos', host);
  return { status: 200, json: page.map(repoObject), headers: link === null ? undefined : { link } };
}

function handleGetRepo(owner: string, name: string): RestReply {
  return { status: 200, json: repoObject(requireRepo(owner, name)) };
}

function handlePatchRepo(owner: string, name: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const data = bodyObject(body);
  const description = stringField(data, 'description');
  if (description !== undefined) repo.description = description;
  if (data.private !== undefined) repo.isPrivate = boolField(data, 'private', repo.isPrivate);
  const branch = stringField(data, 'default_branch');
  if (branch !== undefined) {
    if (!validBranchName(branch)) throw unprocessable(`Invalid default branch: ${branch}`);
    repo.defaultBranch = branch;
  }
  return { status: 200, json: repoObject(repo) };
}

function handleDeleteRepo(owner: string, name: string): RestReply {
  requireRepo(owner, name);
  deleteRepo(owner, name);
  return { status: 204 };
}

function handleCreateRef(owner: string, name: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const data = bodyObject(body);
  const ref = stringField(data, 'ref');
  const sha = stringField(data, 'sha');
  if (ref === undefined || sha === undefined) throw unprocessable('ref and sha are required');
  if (!validRefName(ref)) throw unprocessable(`Invalid ref: ${ref}`);
  if (!isOid(sha)) throw unprocessable(`Invalid sha: ${sha}`);
  if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
  const object = repo.objects.get(sha);
  if (object === undefined) throw unprocessable('Object does not exist');
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') throw unprocessable('A branch must point at a commit');
  repo.refs.set(ref, sha);
  return {
    status: 201,
    json: {
      ref,
      node_id: Buffer.from(`forge:v1:ref:${repo.owner}/${repo.name}#${ref}`, 'utf8').toString('base64'),
      url: `https://api.example.invalid/repos/${owner}/${name}/git/refs/${ref.slice(5)}`,
      object: { sha, type: object.type, url: `https://api.example.invalid/repos/${owner}/${name}/git/${object.type}s/${sha}` },
    },
  };
}

function refObject(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: Buffer.from(`forge:v1:ref:${repo.owner}/${repo.name}#${ref}`, 'utf8').toString('base64'),
    url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`,
    object: { sha, type: object?.type ?? 'commit', url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/git/${object?.type ?? 'commit'}s/${sha}` },
  };
}

function handleGetRefs(owner: string, name: string, rest: string[]): RestReply {
  const repo = requireRepo(owner, name);
  if (rest.length === 0) {
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { status: 200, json: refs.map(([ref, sha]) => refObject(repo, ref, sha)) };
  }
  const joined = rest.join('/');
  const full = `refs/${joined}`;
  const exact = repo.refs.get(full);
  if (exact !== undefined) return { status: 200, json: refObject(repo, full, exact) };
  const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(`${full}/`)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (matches.length === 0) throw notFound('Reference');
  return { status: 200, json: matches.map(([ref, sha]) => refObject(repo, ref, sha)) };
}

function branchObject(repo: Repo, branch: string, sha: string): Record<string, unknown> {
  return {
    name: branch,
    commit: { sha, url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
    protection_url: `https://api.example.invalid/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(branch)}/protection`,
  };
}

function handleListBranches(owner: string, name: string): RestReply {
  const repo = requireRepo(owner, name);
  const branches: Array<{ branch: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ branch: ref.slice('refs/heads/'.length), sha });
  }
  branches.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  return { status: 200, json: branches.map(({ branch, sha }) => branchObject(repo, branch, sha)) };
}

function handleGetBranch(owner: string, name: string, rest: string[]): RestReply {
  const repo = requireRepo(owner, name);
  const branch = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) throw notFound('Branch');
  return { status: 200, json: branchObject(repo, branch, sha) };
}

function handleListCommits(owner: string, name: string, query: URLSearchParams): RestReply {
  const repo = requireRepo(owner, name);
  const ref = query.get('sha');
  const tip = ref === null ? repo.refs.get(defaultBranchRefName(repo)) ?? null : resolveRefToCommit(repo, ref);
  if (tip === null) return { status: 200, json: [] };
  const { perPage, page } = pageParams(query);
  const walked = walkCommits(repo, tip, perPage * page);
  const slice = walked.slice((page - 1) * perPage, page * perPage);
  const rendered: unknown[] = [];
  for (const sha of slice) {
    const object = commitObject(repo, sha);
    if (object !== null) rendered.push(object);
  }
  return { status: 200, json: rendered };
}

function handleGetCommit(owner: string, name: string, sha: string): RestReply {
  const repo = requireRepo(owner, name);
  const resolved = resolveRefToCommit(repo, sha) ?? (isOid(sha) && repo.objects.get(sha)?.type === 'commit' ? sha : null);
  if (resolved === null) throw notFound('Commit');
  const rendered = commitObject(repo, resolved);
  if (rendered === null) throw notFound('Commit');
  return { status: 200, json: rendered };
}

function handlePutContents(owner: string, name: string, segments: string[], body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    throw unprocessable('Invalid content path');
  }
  const data = bodyObject(body);
  const message = stringField(data, 'message');
  const content = stringField(data, 'content');
  if (message === undefined || message === '') throw unprocessable('message is required');
  if (content === undefined) throw unprocessable('content is required');
  const branch = stringField(data, 'branch') ?? repo.defaultBranch;
  if (!validBranchName(branch)) throw unprocessable(`Invalid branch: ${branch}`);
  const expectedSha = stringField(data, 'sha');
  let blob: Buffer;
  try {
    blob = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  } catch {
    throw unprocessable('content is not valid base64');
  }
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined) {
    // A new branch starts from the default branch tip, or from nothing.
    tip = repo.refs.get(defaultBranchRefName(repo));
  }
  const lookup = lookupObject(repo);
  const currentTree = tip === undefined ? null : commitTree(repo, tip);
  const files = currentTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, currentTree);
  const path = segments.join('/');
  const existing = files.get(path);
  const isCreate = existing === undefined;
  if (expectedSha !== undefined) {
    if (isCreate) throw unprocessable('sha was given but the file does not exist');
    if (expectedSha !== existing.oid) throw new ApiError(409, 'sha does not match the current file');
  } else if (!isCreate) {
    throw unprocessable('sha is required to update an existing file');
  }
  const blobOid = putObjectLocal(repo, 'blob', blob);
  let newTree: string;
  try {
    newTree = updateTreePath(lookup, (type, data2) => putObjectLocal(repo, type, data2), currentTree, segments, blobOid, '100644');
  } catch (err) {
    throw unprocessable((err as Error).message);
  }
  const commitMessage = message.endsWith('\n') ? message : `${message}\n`;
  const commit = makeCommit(repo, newTree, tip === undefined ? [] : [tip], commitMessage);
  repo.refs.set(refName, commit);
  return {
    status: isCreate ? 201 : 200,
    json: {
      content: fileObject(repo, path, blobOid, blob),
      commit: commitObject(repo, commit),
    },
  };
}

function handleGetContents(owner: string, name: string, segments: string[], query: URLSearchParams): RestReply {
  const repo = requireRepo(owner, name);
  if (segments.some((segment) => segment === '..' || segment === '.')) throw notFound('Content');
  const { tree } = resolveContentRef(repo, query.get('ref'));
  if (tree === null) throw notFound('Content');
  const path = segments.join('/');
  if (segments.length === 0) {
    const object = repo.objects.get(tree);
    if (object === undefined) throw notFound('Content');
    const entries = parseTree(object.data);
    const rendered = entries.map((entry) => {
      const size = entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0;
      return dirEntryObject(repo, entry.name, entry.name, entry.oid, entry.mode, size);
    });
    return { status: 200, json: rendered };
  }
  const found = lookupPath(repo, tree, segments);
  if (found === null) throw notFound('Content');
  if (found.kind === 'dir') {
    const object = repo.objects.get(found.oid);
    if (object === undefined) throw notFound('Content');
    const entries = parseTree(object.data);
    const rendered = entries.map((entry) => {
      const size = entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0;
      return dirEntryObject(repo, `${path}/${entry.name}`, entry.name, entry.oid, entry.mode, size);
    });
    return { status: 200, json: rendered };
  }
  const object = repo.objects.get(found.oid);
  if (object === undefined || object.type !== 'blob') throw notFound('Content');
  return { status: 200, json: fileObject(repo, path, found.oid, object.data) };
}

function handleDeleteContents(owner: string, name: string, segments: string[], body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    throw unprocessable('Invalid content path');
  }
  const data = bodyObject(body);
  const message = stringField(data, 'message');
  const expectedSha = stringField(data, 'sha');
  if (message === undefined || message === '') throw unprocessable('message is required');
  if (expectedSha === undefined) throw unprocessable('sha is required');
  const branch = stringField(data, 'branch') ?? repo.defaultBranch;
  if (!validBranchName(branch)) throw unprocessable(`Invalid branch: ${branch}`);
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw notFound('Content');
  const lookup = lookupObject(repo);
  const currentTree = commitTree(repo, tip);
  const files = currentTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, currentTree);
  const path = segments.join('/');
  const existing = files.get(path);
  if (existing === undefined) throw notFound('Content');
  if (expectedSha !== existing.oid) throw new ApiError(409, 'sha does not match the current file');
  let newTree: string;
  try {
    newTree = updateTreePath(lookup, (type, data2) => putObjectLocal(repo, type, data2), currentTree, segments, null, '100644');
  } catch (err) {
    throw unprocessable((err as Error).message);
  }
  const commitMessage = message.endsWith('\n') ? message : `${message}\n`;
  const commit = makeCommit(repo, newTree, [tip], commitMessage);
  repo.refs.set(refName, commit);
  return { status: 200, json: { content: null, commit: commitObject(repo, commit) } };
}

function handleCreateLabel(owner: string, name: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const data = bodyObject(body);
  const labelName = stringField(data, 'name');
  if (labelName === undefined || labelName.trim() === '') throw unprocessable('Label name is required');
  if (repo.labels.has(labelName)) throw unprocessable('Label already exists');
  const color = (stringField(data, 'color') ?? 'ededed').replace(/^#/, '');
  const label = { name: labelName, color };
  repo.labels.set(labelName, label);
  return {
    status: 201,
    json: { id: repo.labels.size, node_id: '', name: labelName, color, description: stringField(data, 'description') ?? null, url: `https://api.example.invalid/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}` },
  };
}

function handleListLabels(owner: string, name: string): RestReply {
  const repo = requireRepo(owner, name);
  return {
    status: 200,
    json: [...repo.labels.values()].map((label, index) => ({ id: index + 1, node_id: '', name: label.name, color: label.color, description: null, url: '' })),
  };
}

function parseLabelList(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw unprocessable('labels must be an array');
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    } else {
      throw unprocessable('labels must be strings or label objects');
    }
  }
  return names;
}

function handleCreateIssue(owner: string, name: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const data = bodyObject(body);
  const title = stringField(data, 'title');
  if (title === undefined) throw unprocessable('Title is required');
  const issue = createIssue(repo, title, stringField(data, 'body') ?? '', parseLabelList(data));
  return { status: 201, json: issueObject(repo, issue) };
}

function handleListIssues(owner: string, name: string, query: URLSearchParams, host: string): RestReply {
  const repo = requireRepo(owner, name);
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { page, link } = paginate(issues, query, `/api/v3/repos/${owner}/${name}/issues`, host);
  return { status: 200, json: page.map((issue) => issueObject(repo, issue)), headers: link === null ? undefined : { link } };
}

function resolveNumber(repo: Repo, raw: string): { kind: 'issue' | 'pull'; number: number } {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) throw notFound('Issue');
  if (repo.issues.has(number)) return { kind: 'issue', number };
  if (repo.pulls.has(number)) return { kind: 'pull', number };
  throw notFound('Issue');
}

function handleGetIssue(owner: string, name: string, raw: string): RestReply {
  const repo = requireRepo(owner, name);
  const resolved = resolveNumber(repo, raw);
  if (resolved.kind === 'issue') return { status: 200, json: issueObject(repo, repo.issues.get(resolved.number) as Issue) };
  return { status: 200, json: pullAsIssueObject(repo, repo.pulls.get(resolved.number) as PullRequest) };
}

function handlePatchIssue(owner: string, name: string, raw: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const resolved = resolveNumber(repo, raw);
  const data = bodyObject(body);
  const state = stringField(data, 'state');
  if (state !== undefined && state !== 'open' && state !== 'closed') throw unprocessable('state must be open or closed');
  const labels = data.labels === undefined ? undefined : parseLabelList(data);
  if (labels !== undefined) {
    for (const label of labels) if (!repo.labels.has(label)) throw unprocessable(`Label ${label} does not exist`);
  }
  if (resolved.kind === 'issue') {
    const issue = repo.issues.get(resolved.number) as Issue;
    if (state !== undefined) issue.state = state;
    const title = stringField(data, 'title');
    if (title !== undefined) issue.title = title;
    const bodyText = stringField(data, 'body');
    if (bodyText !== undefined) issue.body = bodyText;
    if (labels !== undefined) issue.labels = labels;
    return { status: 200, json: issueObject(repo, issue) };
  }
  const pr = repo.pulls.get(resolved.number) as PullRequest;
  if (state === 'open' && pr.merged) throw unprocessable('A merged pull request cannot be reopened');
  if (state !== undefined) pr.state = state;
  const title = stringField(data, 'title');
  if (title !== undefined) pr.title = title;
  const bodyText = stringField(data, 'body');
  if (bodyText !== undefined) pr.body = bodyText;
  return { status: 200, json: pullAsIssueObject(repo, pr) };
}

function handleCreateComment(owner: string, name: string, raw: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const resolved = resolveNumber(repo, raw);
  const data = bodyObject(body);
  const text = stringField(data, 'body');
  if (text === undefined) throw unprocessable('Comment body is required');
  const comment = addComment(repo, resolved.number, resolved.kind, text);
  return { status: 201, json: commentObject(repo, comment) };
}

function handleListComments(owner: string, name: string, raw: string): RestReply {
  const repo = requireRepo(owner, name);
  const resolved = resolveNumber(repo, raw);
  const comments = repo.comments.filter((comment) => comment.kind === resolved.kind && comment.subject === resolved.number);
  return { status: 200, json: comments.map((comment) => commentObject(repo, comment)) };
}

function handleCreatePull(owner: string, name: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const data = bodyObject(body);
  const title = stringField(data, 'title');
  if (title === undefined) throw unprocessable('Title is required');
  const head = stringField(data, 'head');
  const base = stringField(data, 'base');
  if (head === undefined || base === undefined) throw unprocessable('head and base are required');
  const pr = createPull(repo, title, stringField(data, 'body') ?? '', head, base);
  return { status: 201, json: pullObject(repo, pr) };
}

function handleListPulls(owner: string, name: string, query: URLSearchParams, host: string): RestReply {
  const repo = requireRepo(owner, name);
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, link } = paginate(pulls, query, `/api/v3/repos/${owner}/${name}/pulls`, host);
  return { status: 200, json: page.map((pr) => pullObject(repo, pr)), headers: link === null ? undefined : { link } };
}

function handleGetPull(owner: string, name: string, raw: string): RestReply {
  const repo = requireRepo(owner, name);
  const number = Number(raw);
  const pr = repo.pulls.get(number);
  if (pr === undefined) throw notFound('Pull request');
  return { status: 200, json: pullObject(repo, pr) };
}

function handlePullFiles(owner: string, name: string, raw: string): RestReply {
  const repo = requireRepo(owner, name);
  const number = Number(raw);
  const pr = repo.pulls.get(number);
  if (pr === undefined) throw notFound('Pull request');
  const files = pullFiles(repo, pr);
  return {
    status: 200,
    json: files.map((file) => ({
      sha: file.newOid ?? file.oldOid ?? ZERO_OID,
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: `https://example.invalid/${owner}/${name}/blob/HEAD/${file.path}`,
      raw_url: `https://example.invalid/${owner}/${name}/raw/HEAD/${file.path}`,
      contents_url: `https://api.example.invalid/repos/${owner}/${name}/contents/${file.path}`,
    })),
  };
}

function handleMergePull(owner: string, name: string, raw: string, body: unknown): RestReply {
  const repo = requireRepo(owner, name);
  const number = Number(raw);
  const pr = repo.pulls.get(number);
  if (pr === undefined) throw notFound('Pull request');
  const data = bodyObject(body);
  const method = stringField(data, 'merge_method') ?? 'squash';
  const { sha } = mergePull(repo, pr, method);
  return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function routeRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): RestReply {
  if (segments.length === 0) {
    if (method === 'GET') return handleRoot();
    throw new ApiError(405, 'Method not allowed');
  }
  const [first, second, third, ...rest] = segments;
  if (first === 'meta' && segments.length === 1) {
    if (method === 'GET') return { status: 200, json: { installed_version: '1.0.0' } };
    throw new ApiError(405, 'Method not allowed');
  }
  if (first === 'user' && segments.length === 1) {
    if (method === 'GET') return { status: 200, json: { ...userObject(), public_repos: listRepos().length, followers: 0, following: 0, created_at: FIXED_ISO, updated_at: FIXED_ISO } };
    throw new ApiError(405, 'Method not allowed');
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'POST') return handleCreateRepo(body);
    if (method === 'GET') return handleListUserRepos(query, host);
    throw new ApiError(405, 'Method not allowed');
  }
  if (first !== 'repos' || second === undefined || third === undefined) throw notFound('Route');
  const owner = second;
  const repoName = third;
  if (rest.length === 0) {
    if (method === 'GET') return handleGetRepo(owner, repoName);
    if (method === 'PATCH') return handlePatchRepo(owner, repoName, body);
    if (method === 'DELETE') return handleDeleteRepo(owner, repoName);
    throw new ApiError(405, 'Method not allowed');
  }
  const [resource, ...tail] = rest;
  if (resource === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) return handleCreateRef(owner, repoName, body);
    if (method === 'GET') return handleGetRefs(owner, repoName, tail.slice(1));
    throw new ApiError(405, 'Method not allowed');
  }
  if (resource === 'branches') {
    if (method === 'GET' && tail.length === 0) return handleListBranches(owner, repoName);
    if (method === 'GET') return handleGetBranch(owner, repoName, tail);
    throw new ApiError(405, 'Method not allowed');
  }
  if (resource === 'commits') {
    if (method === 'GET' && tail.length === 0) return handleListCommits(owner, repoName, query);
    if (method === 'GET' && tail.length === 1) return handleGetCommit(owner, repoName, tail[0]);
    throw new ApiError(405, 'Method not allowed');
  }
  if (resource === 'contents') {
    if (method === 'PUT') return handlePutContents(owner, repoName, tail, body);
    if (method === 'GET') return handleGetContents(owner, repoName, tail, query);
    if (method === 'DELETE') return handleDeleteContents(owner, repoName, tail, body);
    throw new ApiError(405, 'Method not allowed');
  }
  if (resource === 'labels') {
    if (method === 'POST' && tail.length === 0) return handleCreateLabel(owner, repoName, body);
    if (method === 'GET' && tail.length === 0) return handleListLabels(owner, repoName);
    throw new ApiError(405, 'Method not allowed');
  }
  if (resource === 'issues') {
    if (tail.length === 0) {
      if (method === 'POST') return handleCreateIssue(owner, repoName, body);
      if (method === 'GET') return handleListIssues(owner, repoName, query, host);
      throw new ApiError(405, 'Method not allowed');
    }
    if (tail.length === 1) {
      if (method === 'GET') return handleGetIssue(owner, repoName, tail[0]);
      if (method === 'PATCH') return handlePatchIssue(owner, repoName, tail[0], body);
      throw new ApiError(405, 'Method not allowed');
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (method === 'POST') return handleCreateComment(owner, repoName, tail[0], body);
      if (method === 'GET') return handleListComments(owner, repoName, tail[0]);
      throw new ApiError(405, 'Method not allowed');
    }
    throw notFound('Route');
  }
  if (resource === 'pulls') {
    if (tail.length === 0) {
      if (method === 'POST') return handleCreatePull(owner, repoName, body);
      if (method === 'GET') return handleListPulls(owner, repoName, query, host);
      throw new ApiError(405, 'Method not allowed');
    }
    if (tail.length === 1) {
      if (method === 'GET') return handleGetPull(owner, repoName, tail[0]);
      throw new ApiError(405, 'Method not allowed');
    }
    if (tail.length === 2 && tail[1] === 'files') {
      if (method === 'GET') return handlePullFiles(owner, repoName, tail[0]);
      throw new ApiError(405, 'Method not allowed');
    }
    if (tail.length === 2 && tail[1] === 'merge') {
      if (method === 'PUT') return handleMergePull(owner, repoName, tail[0], body);
      throw new ApiError(405, 'Method not allowed');
    }
    throw notFound('Route');
  }
  throw notFound('Route');
}
