// A small GraphQL implementation: a lexer and recursive-descent parser for
// the query language, an executor with field validation and error collection,
// and resolvers over the same store the REST and MCP surfaces use. It covers
// the schema surface the conformance documents exercise: queries, mutations,
// fragments, aliases, variables, directives, connections and introspection.

import { ApiError, addComment, createIssue, createPull, mergePull, pullFiles, pullMergeable } from './rest.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  FIXED_ISO,
  getRepo,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

export class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' ) {
      if (source.slice(index, index + 3) !== '...') throw new GraphQLSyntaxError(`Unexpected character "." at offset ${index}`);
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(index, index + 3) === '"""') {
        // Block string.
        let end = index + 3;
        let raw = '';
        while (end < source.length) {
          if (source.slice(end, end + 4) === '\\"""') {
            raw += '"""';
            end += 4;
            continue;
          }
          if (source.slice(end, end + 3) === '"""') break;
          raw += source[end];
          end += 1;
        }
        if (end >= source.length) throw new GraphQLSyntaxError('Unterminated block string');
        const lines = raw.split('\n');
        if (lines.length > 1 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
        tokens.push({ kind: 'string', value: lines.join('\n') });
        index = end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') {
          const escape = source[end + 1];
          if (escape === undefined) throw new GraphQLSyntaxError('Unterminated string');
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === 'u') {
            const hex = source.slice(end + 2, end + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError(`Invalid unicode escape \\u${hex}`);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            end += 6;
          } else if (escapes[escape] !== undefined) {
            value += escapes[escape];
            end += 2;
          } else {
            throw new GraphQLSyntaxError(`Invalid escape \\${escape}`);
          }
        } else {
          if (source[end] === '\n') throw new GraphQLSyntaxError('Unterminated string');
          value += source[end];
          end += 1;
        }
      }
      if (end >= source.length) throw new GraphQLSyntaxError('Unterminated string');
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) throw new GraphQLSyntaxError(`Invalid number at offset ${index}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      index += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(ch)} at offset ${index}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

export interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

export interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: DirectiveNode[];
  selectionSet?: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
}

export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDefinition {
  name: string;
  defaultValue?: ValueNode;
}

export interface OperationDefinition {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentDefinition {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export type Definition = OperationDefinition | FragmentDefinition;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.advance();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.advance();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new GraphQLSyntaxError(`Expected name ${value ?? ''} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): Definition {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'Operation', operation: 'query', variableDefinitions: [], directives: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.advance().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.expectName();
      const variableDefinitions = this.parseVariableDefinitions();
      const directives = this.parseDirectives();
      return { kind: 'Operation', operation, name, variableDefinitions, directives, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.advance();
      const name = this.expectName();
      if (name === 'on') throw new GraphQLSyntaxError('Fragment name cannot be "on"');
      this.expectName('on');
      const typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'Fragment', name, typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    throw new GraphQLSyntaxError(`Unexpected ${JSON.stringify(token.value)} at the start of a definition`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    if (!this.skipPunct('(')) return [];
    const definitions: VariableDefinition[] = [];
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.skipPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      definitions.push({ name, defaultValue });
    }
    return definitions;
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.advance();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.expectName();
        return { kind: 'FragmentSpread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | undefined;
      if (next.kind === 'name' && next.value === 'on') {
        this.advance();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    if (!this.skipPunct('(')) return [];
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(constLiteral: boolean): ValueNode {
    const token = this.advance();
    if (token.kind === 'punct' && token.value === '$') {
      if (constLiteral) throw new GraphQLSyntaxError('Variables are not allowed in constant values');
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'Int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'Float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(constLiteral));
      this.advance();
      return { kind: 'List', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constLiteral) });
      }
      this.advance();
      return { kind: 'Object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`Unexpected value ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// schema tables
// ---------------------------------------------------------------------------

const FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'url', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt']),
  User: new Set(['id', 'login', 'name', 'email', 'url', 'avatarUrl']),
  Ref: new Set(['name', 'id']),
  Issue: new Set(['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestChangedFileEdge: new Set(['node', 'cursor']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt', 'updatedAt', 'url']),
  CommentEdge: new Set(['node', 'cursor']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'interfaces']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description']),
  __Schema: new Set(['queryType', 'mutationType', 'subscriptionType', 'types', 'directives']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment']);

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR';
  fields: string[];
  enumValues?: string[];
}

const TYPE_INFO: Readonly<Record<string, TypeInfo>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'mergedAt', 'createdAt', 'updatedAt', 'author', 'url'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'id'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  MergeMethod: { kind: 'ENUM', fields: [], enumValues: ['SQUASH', 'MERGE', 'REBASE'] },
  String: { kind: 'SCALAR', fields: [] },
  Int: { kind: 'SCALAR', fields: [] },
  Boolean: { kind: 'SCALAR', fields: [] },
  ID: { kind: 'SCALAR', fields: [] },
};

// ---------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------

type Resolver = (args: Record<string, unknown>) => unknown;
type GqlNode = Record<string, unknown> & { __typename: string };

function userNode(): GqlNode {
  return {
    __typename: 'User',
    id: Buffer.from(`forge:v1:user:${VIEWER_LOGIN}`, 'utf8').toString('base64'),
    login: VIEWER_LOGIN,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    url: `https://example.invalid/${VIEWER_LOGIN}`,
    avatarUrl: `https://avatars.example.invalid/u/${VIEWER_ID}`,
  };
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: number;
  after?: number | null;
  states?: string[];
  direction?: 'ASC' | 'DESC';
}

/** Slice an ordered list into a Relay-style connection page. */
function paginateConnection<T extends { createdSeq: number }>(
  items: readonly T[],
  args: PageArgs,
  buildNode: (item: T) => GqlNode,
  connectionType: string,
  edgeType: string,
): GqlNode {
  const direction = args.direction ?? 'DESC';
  const ordered = [...items].sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const afterSeq = args.after ?? null;
  let start = 0;
  if (afterSeq !== null) {
    const index = ordered.findIndex((item) => item.createdSeq === afterSeq);
    start = index < 0 ? 0 : index + 1;
  }
  const first = args.first;
  const page = first === undefined ? ordered.slice(start) : ordered.slice(start, start + first);
  const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1].createdSeq);
  const startCursor = page.length === 0 ? null : encodeCursor(page[0].createdSeq);
  const nodes = page.map(buildNode);
  return {
    __typename: connectionType,
    nodes,
    edges: nodes.map((node, index) => ({ __typename: edgeType, node, cursor: encodeCursor(page[index].createdSeq) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < ordered.length,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
    totalCount: ordered.length,
  };
}

function issueStateArg(args: Record<string, unknown>): string[] | undefined {
  const states = args.states;
  if (!Array.isArray(states)) return undefined;
  return states.filter((state): state is string => typeof state === 'string');
}

function orderDirectionArg(args: Record<string, unknown>): 'ASC' | 'DESC' {
  const orderBy = args.orderBy;
  if (typeof orderBy === 'object' && orderBy !== null) {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'ASC' || direction === 'DESC') return direction;
  }
  return 'DESC';
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    closedAt: issue.state === 'closed' ? FIXED_ISO : null,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(repo: Repo, pr: PullRequest): GqlNode {
  const node: GqlNode = {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: pullMergeable(repo, pr),
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    mergedAt: pr.mergedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
  node.files = ((args: Record<string, unknown>): GqlNode => {
    const files = pullFiles(repo, pr);
    const first = typeof args.first === 'number' ? args.first : undefined;
    const page = first === undefined ? files : files.slice(0, first);
    const nodes = page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path, additions: file.additions, deletions: file.deletions }));
    return {
      __typename: 'PullRequestChangedFileConnection',
      nodes,
      edges: nodes.map((fileNode) => ({ __typename: 'PullRequestChangedFileEdge', node: fileNode, cursor: null })),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: first !== undefined && files.length > first,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      totalCount: files.length,
    };
  }) as Resolver;
  return node;
}

function commentNode(repo: Repo, comment: Comment): GqlNode {
  return {
    __typename: 'IssueComment',
    id: commentGlobalId(repo, comment.subject, comment.id),
    body: comment.body,
    author: userNode(),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${comment.subject}#issuecomment-${comment.id}`,
  };
}

function repoNode(repo: Repo): GqlNode {
  const node: GqlNode = {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    owner: userNode(),
    defaultBranchRef: null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) node.defaultBranchRef = { __typename: 'Ref', id: `ref:${repo.defaultBranch}`, name: repo.defaultBranch };
  node.issue = ((args: Record<string, unknown>): GqlNode | null => {
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : issueNode(repo, issue);
  }) as Resolver;
  node.issues = ((args: Record<string, unknown>): GqlNode => {
    let issues = [...repo.issues.values()];
    const states = issueStateArg(args);
    if (states !== undefined) {
      issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    return paginateConnection(
      issues,
      { first: typeof args.first === 'number' ? args.first : undefined, after: decodeCursor(args.after), direction: orderDirectionArg(args) },
      (issue) => issueNode(repo, issue),
      'IssueConnection',
      'IssueEdge',
    );
  }) as Resolver;
  node.pullRequest = ((args: Record<string, unknown>): GqlNode | null => {
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pr = repo.pulls.get(number);
    return pr === undefined ? null : pullNode(repo, pr);
  }) as Resolver;
  node.pullRequests = ((args: Record<string, unknown>): GqlNode => {
    let pulls = [...repo.pulls.values()];
    const states = issueStateArg(args);
    if (states !== undefined) {
      pulls = pulls.filter((pr) => {
        const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(state);
      });
    }
    return paginateConnection(
      pulls,
      { first: typeof args.first === 'number' ? args.first : undefined, after: decodeCursor(args.after), direction: orderDirectionArg(args) },
      (pr) => pullNode(repo, pr),
      'PullRequestConnection',
      'PullRequestEdge',
    );
  }) as Resolver;
  return node;
}

function typeNode(name: string): GqlNode | null {
  const info = TYPE_INFO[name];
  if (info === undefined) return null;
  const node: GqlNode = {
    __typename: '__Type',
    name,
    kind: info.kind,
    description: null,
    ofType: null,
    interfaces: [],
  };
  node.fields = ((args: Record<string, unknown>): GqlNode[] | null => {
    void args;
    if (info.kind !== 'OBJECT' && info.kind !== 'INTERFACE') return null;
    return info.fields.map((field) => ({ __typename: '__Field', name: field, description: null, args: [], type: null }));
  }) as Resolver;
  node.enumValues = ((args: Record<string, unknown>): GqlNode[] | null => {
    void args;
    if (info.kind !== 'ENUM' || info.enumValues === undefined) return null;
    return info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null }));
  }) as Resolver;
  return node;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

interface ExecutorContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => evalValue(value, variables));
    case 'Object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = evalValue(field.value, variables);
      return object;
    }
  }
}

function evalArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const evaluated: Record<string, unknown> = {};
  for (const arg of args) evaluated[arg.name] = evalValue(arg.value, variables);
  return evaluated;
}

function directivesAllow(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const args = evalArgs(directive.args, variables);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if !== true) return false;
  }
  return true;
}

function typeConditionApplies(condition: string | undefined, parentType: string): boolean {
  if (condition === undefined) return true;
  if (condition === parentType) return true;
  if (condition === 'Node' && NODE_TYPES.has(parentType)) return true;
  return false;
}

interface CollectedField {
  name: string;
  responseKey: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSets: SelectionNode[][];
}

function collectFields(
  selections: SelectionNode[],
  parentType: string,
  ctx: ExecutorContext,
  visited: ReadonlySet<string>,
  out: Map<string, CollectedField>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      const responseKey = selection.alias ?? selection.name;
      const existing = out.get(responseKey);
      if (existing !== undefined) {
        if (selection.selectionSet !== undefined) existing.selectionSets.push(selection.selectionSet);
      } else {
        out.set(responseKey, {
          name: selection.name,
          responseKey,
          args: selection.args,
          selectionSets: selection.selectionSet === undefined ? [] : [selection.selectionSet],
        });
      }
    } else if (selection.kind === 'FragmentSpread') {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      if (visited.has(selection.name)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (!typeConditionApplies(fragment.typeCondition, parentType)) continue;
      if (!directivesAllow(fragment.directives, ctx.variables)) continue;
      collectFields(fragment.selectionSet, parentType, ctx, new Set([...visited, selection.name]), out);
    } else {
      if (!directivesAllow(selection.directives, ctx.variables)) continue;
      if (!typeConditionApplies(selection.typeCondition, parentType)) continue;
      collectFields(selection.selectionSet, parentType, ctx, visited, out);
    }
  }
}

function executeSelectionSet(
  selections: SelectionNode[],
  parent: Record<string, unknown>,
  parentType: string,
  ctx: ExecutorContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const fields = new Map<string, CollectedField>();
  collectFields(selections, parentType, ctx, new Set(), fields);
  const result: Record<string, unknown> = {};
  for (const field of fields.values()) {
    const fieldPath = [...path, field.responseKey];
    const known = FIELDS[parentType];
    if (field.name !== '__typename' && (known === undefined || !known.has(field.name))) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path: fieldPath });
      result[field.responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      if (field.name === '__typename') {
        value = parentType;
      } else {
        const raw = parent[field.name];
        value = typeof raw === 'function' ? (raw as Resolver)(evalArgs(field.args, ctx.variables)) : raw === undefined ? null : raw;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Field resolution failed';
      ctx.errors.push({ message, path: fieldPath });
      result[field.responseKey] = null;
      continue;
    }
    const merged = field.selectionSets.flat();
    if (merged.length > 0) {
      result[field.responseKey] = completeValue(value, merged, ctx, fieldPath);
    } else {
      result[field.responseKey] = value === undefined ? null : value;
    }
  }
  return result;
}

function completeValue(value: unknown, selections: SelectionNode[], ctx: ExecutorContext, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, selections, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const node = value as GqlNode;
    const typeName = typeof node.__typename === 'string' ? node.__typename : 'Object';
    return executeSelectionSet(selections, node, typeName, ctx, path);
  }
  ctx.errors.push({ message: `Field at ${path.join('.')} has a selection set but resolved to a scalar.`, path });
  return null;
}

// ---------------------------------------------------------------------------
// root resolvers
// ---------------------------------------------------------------------------

function repoFromGlobalId(id: unknown): Repo {
  if (typeof id !== 'string') throw new FieldError('A repository id is required');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') throw new FieldError(`Unknown repository id: ${id}`);
  const repo = getRepo(decoded.owner, decoded.name);
  if (repo === undefined) throw new FieldError(`Repository not found: ${decoded.owner}/${decoded.name}`);
  return repo;
}

function queryRoot(): GqlNode {
  const root: GqlNode = { __typename: 'Query' };
  root.viewer = userNode();
  root.repository = ((args: Record<string, unknown>): GqlNode | null => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER_LOGIN) return null;
    const repo = getRepo(owner, name);
    return repo === undefined ? null : repoNode(repo);
  }) as Resolver;
  root.node = ((args: Record<string, unknown>): GqlNode | null => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    const repo = getRepo(decoded.owner, decoded.name);
    if (repo === undefined) return null;
    if (decoded.kind === 'repo') return repoNode(repo);
    if (decoded.kind === 'issue') {
      const issue = repo.issues.get(decoded.number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (decoded.kind === 'pull') {
      const pr = repo.pulls.get(decoded.number);
      return pr === undefined ? null : pullNode(repo, pr);
    }
    const comment = repo.comments.find((item) => item.id === decoded.commentId && item.subject === decoded.number);
    return comment === undefined ? null : commentNode(repo, comment);
  }) as Resolver;
  root.__type = ((args: Record<string, unknown>): GqlNode | null => {
    const name = args.name;
    return typeof name === 'string' ? typeNode(name) : null;
  }) as Resolver;
  root.__schema = {
    __typename: '__Schema',
    queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', description: null, fields: null, enumValues: null, ofType: null, interfaces: [] },
    mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', description: null, fields: null, enumValues: null, ofType: null, interfaces: [] },
    subscriptionType: null,
    types: [],
    directives: [],
  };
  return root;
}

function mutationRoot(): GqlNode {
  const root: GqlNode = { __typename: 'Mutation' };
  const wrap = (fn: (input: Record<string, unknown>) => unknown): Resolver => {
    return (args: Record<string, unknown>): unknown => {
      const input = args.input;
      if (typeof input !== 'object' || input === null) throw new FieldError('input is required');
      try {
        return fn(input as Record<string, unknown>);
      } catch (err) {
        if (err instanceof ApiError) throw new FieldError(err.message);
        throw err;
      }
    };
  };
  root.createIssue = wrap((input) => {
    const repo = repoFromGlobalId(input.repositoryId);
    const title = input.title;
    if (typeof title !== 'string' || title.trim() === '') throw new FieldError('Title is required');
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = createIssue(repo, title, body, []);
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: input.clientMutationId ?? null };
  });
  root.closeIssue = wrap((input) => {
    const id = input.issueId;
    if (typeof id !== 'string') throw new FieldError('An issue id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'issue') throw new FieldError(`Unknown issue id: ${id}`);
    const repo = getRepo(decoded.owner, decoded.name);
    if (repo === undefined) throw new FieldError('Repository not found');
    const issue = repo.issues.get(decoded.number);
    if (issue === undefined) throw new FieldError('Issue not found');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue), clientMutationId: input.clientMutationId ?? null };
  });
  root.createPullRequest = wrap((input) => {
    const repo = repoFromGlobalId(input.repositoryId);
    const title = input.title;
    const head = input.headRefName;
    const base = input.baseRefName;
    if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
      throw new FieldError('title, headRefName and baseRefName are required');
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const pr = createPull(repo, title, body, head, base);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pr), clientMutationId: input.clientMutationId ?? null };
  });
  root.mergePullRequest = wrap((input) => {
    const id = input.pullRequestId;
    if (typeof id !== 'string') throw new FieldError('A pull request id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'pull') throw new FieldError(`Unknown pull request id: ${id}`);
    const repo = getRepo(decoded.owner, decoded.name);
    if (repo === undefined) throw new FieldError('Repository not found');
    const pr = repo.pulls.get(decoded.number);
    if (pr === undefined) throw new FieldError('Pull request not found');
    const method = input.mergeMethod;
    const mapped = method === 'MERGE' ? 'merge' : method === 'REBASE' ? 'rebase' : 'squash';
    mergePull(repo, pr, mapped);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pr), clientMutationId: input.clientMutationId ?? null };
  });
  root.addComment = wrap((input) => {
    const id = input.subjectId;
    if (typeof id !== 'string') throw new FieldError('A subject id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || (decoded.kind !== 'issue' && decoded.kind !== 'pull')) throw new FieldError(`Unknown subject id: ${id}`);
    const repo = getRepo(decoded.owner, decoded.name);
    if (repo === undefined) throw new FieldError('Repository not found');
    const exists = decoded.kind === 'issue' ? repo.issues.has(decoded.number) : repo.pulls.has(decoded.number);
    if (!exists) throw new FieldError('Subject not found');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new FieldError('Comment body is required');
    const comment = addComment(repo, decoded.number, decoded.kind, body);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: commentNode(repo, comment), cursor: encodeCursor(comment.createdSeq) },
      clientMutationId: input.clientMutationId ?? null,
    };
  });
  return root;
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  json: unknown;
}

function executeOne(request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
  }
  const body = request as Record<string, unknown>;
  const query = body.query;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables)
    ? body.variables
    : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let definitions: Definition[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query did not parse';
    return { errors: [{ message: `Syntax Error: ${message}` }] };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations: OperationDefinition[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'Fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationDefinition | undefined;
  if (operationName !== undefined) {
    operation = operations.find((item) => item.name === operationName);
    if (operation === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length === 0) {
    return { errors: [{ message: 'Must provide an operation.' }] };
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const effectiveVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (effectiveVariables[definition.name] === undefined && definition.defaultValue !== undefined) {
      effectiveVariables[definition.name] = evalValue(definition.defaultValue, {});
    }
  }
  const ctx: ExecutorContext = { variables: effectiveVariables, fragments, errors: [] };
  const root = operation.operation === 'mutation' ? mutationRoot() : queryRoot();
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, root, rootType, ctx, []);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Handle one GraphQL request body (a single operation or a batch array). */
export function handleGraphQL(body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((request) => executeOne(request)) };
  }
  return { status: 200, json: executeOne(body) };
}
