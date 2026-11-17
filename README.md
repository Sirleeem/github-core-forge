[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sirleeem/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sirleeem/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-forge

A GitHub-compatible git forge in a single dependency-free Node process, built
for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01)
on [make.fun](https://make.fun). It serves real git smart HTTP, the REST v3
API, GraphQL, and MCP, all backed by one in-memory store, with no git binary,
no database, and no network access beyond the harness.

## Run it

Requires Node 22.18 or newer (type stripping, no build step, no packages to
install).

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:PORT \
MAKEFUN_SHOP_TOKEN=<bearer-token> \
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` answers
`{"done": true}`, then exits 0. `GET /healthz` answers `{"ok": true}`.

For local development, `MAKEFUN_SHOP_TOKEN` may be left unset, in which case
all requests are accepted.

## What it covers

**Git smart HTTP** (`/{owner}/{repo}.git`)

- Protocol v2 (`ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch` with
  shallow/deepen/deepen-since/deepen-not) and protocol v0 (fetch with
  multi_ack_detailed negotiation, shallow boundaries, sideband framing).
- `receive-pack` pushes with per-ref report-status, fast-forward enforcement
  (`non-fast-forward` refusals), branch/tag create/update/delete, and mixed
  ok/ng reports.
- Packfiles: reads OFS_DELTA and REF_DELTA packs including thin packs,
  verifies trailer checksums, validates inflated sizes and delta cycles;
  writes plain version 2 packs. All object ids are recomputed SHA-1.
- Verified against the real git binary: clone, push, pull, fetch, shallow
  clone, deepen, unshallow, tags, and non-fast-forward refusal, in both
  protocol versions.

**REST v3** (`/api/v3`)

- Repositories (create/read/update/delete, paginated lists with `Link`
  headers), git refs and branches, commit history, contents (create/update/
  delete with real commits and sha conflict detection), labels, issues,
  comments, and pull requests with file diffs and squash/merge/rebase merges
  backed by a real three-way merge with conflict detection.
- Issues and pull requests share one number sequence per repository, as on
  GitHub. Every response is JSON with `X-GitHub-Request-Id` and
  `X-OAuth-Scopes`.

**GraphQL** (`/api/graphql`)

- A small parser and executor: operations, fragments, aliases, variables,
  `@skip`/`@include`, batched requests, field validation with collected
  errors, and introspection (`__type`, `__schema`).
- Queries (`viewer`, `repository`, `node`), connections with cursor
  pagination, and mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`) that read back
  through REST.

**MCP** (`/mcp`)

- JSON-RPC 2.0 over Streamable HTTP, both the modern `server/discover` era
  and the legacy `initialize` handshake, with six tools: `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Harness lifecycle: bind, register, poll done, exit. |
| `app.ts` | HTTP server, routing, bearer auth, response envelope. |
| `git.ts` | Object model, packfile codec, pkt-lines, graph algorithms, diff/merge. |
| `githttp.ts` | Smart-HTTP advertisements, v2/v0 upload-pack, receive-pack. |
| `store.ts` | In-memory store, fixed timestamps, global ids, renderers. |
| `rest.ts` | REST v3 routes plus the shared issue/PR/merge operations. |
| `graphql.ts` | GraphQL lexer, parser, executor, schema, resolvers. |
| `mcp.ts` | MCP handshake, tool list, tool dispatch. |

## Determinism

All created objects, commits, and timestamps use one fixed timestamp (from
`MAKEFUN_TRIAL_NOW` when set, else 2025-01-01T00:00:00Z). No wall clock or
unseeded randomness reaches stored state, so a live run and its replay
produce identical results.

## Verification

The kit's local conformance suite passes 120/120 checks (git 30, repos 15,
issues 15, pulls 20, protocol 5, GraphQL 20, MCP 15) with a local score of
989/1000, and the same check bits across repeated runs. Real git operations
were exercised separately against a running server, including a 750-object
v0 clone, REF_DELTA pack ingestion, multi-round fetch negotiation, and
corrupt-pack handling.

## License

MIT. See [LICENSE](LICENSE).
