// The git smart-HTTP surface: info/refs advertisements, protocol v2 and v0
// upload-pack (fetch/clone) and v0 receive-pack (push). The wire shapes here
// follow git's pack-protocol and protocol-v2 documentation.

import {
  collectClosure,
  decodePackets,
  DELIM_PACKET,
  emptyPack,
  encodePackets,
  FLUSH_PACKET,
  GitError,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  peelToNonTag,
  pktLine,
  readPack,
  shallowBoundaries,
  sideband,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { defaultBranchRefName, FIXED_ISO, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, payload: unknown): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(payload), 'utf8') };
}

function notFoundResponse(repoName: string): GitResponse {
  return jsonResponse(404, { message: `Repository not found: ${repoName}` });
}

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function uploadCaps(repo: Repo): string {
  return `multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow symref=HEAD:${defaultBranchRefName(repo)}`;
}

const RECEIVE_CAPS = 'report-status delete-refs side-band-64k';

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(defaultBranchRefName(repo));
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const lookupOf = (repo: Repo): ((oid: string) => GitObject | undefined) => (oid) => repo.objects.get(oid);

/** The `# service=...` preamble every advertisement opens with, plus its flush. */
function preamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH_PACKET]);
}

/** The v0 ref advertisement shared by upload-pack and receive-pack. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : RECEIVE_CAPS;
  const lookup = lookupOf(repo);
  const parts: Buffer[] = [preamble(service)];
  const head = headOid(repo);
  if (head === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const [name, oid] of sortedRefs(repo)) {
      parts.push(pktLine(`${oid} ${name}\n`));
      if (service === 'git-upload-pack' && name.startsWith('refs/tags/')) {
        const object = lookup(oid);
        if (object !== undefined && object.type === 'tag') {
          parts.push(pktLine(`${peelToNonTag(lookup, oid)} ${name}^{}\n`));
        }
      }
    }
  }
  parts.push(FLUSH_PACKET);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement (upload-pack only). */
function v2Advertisement(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    preamble('git-upload-pack'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow ofs-delta\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PACKET,
  ]);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  repo: Repo | undefined,
  repoName: string,
  service: string | null,
  protocolHeader: string | undefined,
): GitResponse {
  if (repo === undefined) return notFoundResponse(repoName);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonResponse(400, { message: `Unknown git service: ${service ?? ''}` });
  }
  if (service === 'git-upload-pack' && protocolHeader?.includes('version=2')) {
    return { status: 200, contentType: UPLOAD_ADVERTISEMENT, body: v2Advertisement(repo) };
  }
  const body = v0Advertisement(repo, service);
  return { status: 200, contentType: service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT, body };
}

// ---------------------------------------------------------------------------
// fetch computation shared by v0 and v2
// ---------------------------------------------------------------------------

interface FetchParams {
  wants: string[];
  haves: string[];
  shallowDeclared: string[];
  depth?: number;
  since?: number;
  deepenNotRefs: string[];
}

interface FetchResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

function computeFetch(repo: Repo, params: FetchParams): FetchResult {
  const lookup = lookupOf(repo);
  const exclude = new Set<string>();
  for (const ref of params.deepenNotRefs) {
    const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (oid !== undefined) {
      for (const included of collectClosure(lookup, [oid]).included) exclude.add(included);
    }
  }
  const wantSet = collectClosure(lookup, params.wants, {
    depth: params.depth,
    since: params.since,
    exclude,
  }).included;
  const haveSet = collectClosure(lookup, params.haves, {
    stopAt: new Set(params.shallowDeclared),
    exclude,
  }).included;
  const sendSet = new Set<string>();
  for (const oid of wantSet) if (!haveSet.has(oid)) sendSet.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...sendSet].sort()) {
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = objects.length === 0 ? emptyPack() : writePack(objects);
  const shallow = shallowBoundaries(lookup, wantSet).filter((oid) => sendSet.has(oid)).sort();
  const unshallow: string[] = [];
  for (const boundary of params.shallowDeclared) {
    if (!wantSet.has(boundary)) continue;
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    let parents: string[];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      continue;
    }
    if (parents.every((parent) => wantSet.has(parent))) unshallow.push(boundary);
  }
  return { pack, shallow, unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------

function textOf(payload: Buffer): string {
  return payload.toString('utf8');
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lookup = lookupOf(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headOid(repo);
  if (head !== undefined) {
    if (matches('HEAD')) {
      lines.push(symrefs ? `${head} HEAD symref-target:${defaultBranchRefName(repo)}\n` : `${head} HEAD\n`);
    }
    for (const [name, oid] of sortedRefs(repo)) {
      if (!matches(name)) continue;
      let line = `${oid} ${name}`;
      if (peel && name.startsWith('refs/tags/')) {
        const object = lookup(oid);
        if (object !== undefined && object.type === 'tag') {
          line += ` peeled:${peelToNonTag(lookup, oid)}`;
        }
      }
      lines.push(`${line}\n`);
    }
  } else if (unborn && matches('HEAD')) {
    lines.push(`unborn HEAD symref-target:${defaultBranchRefName(repo)}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH_PACKET]);
}

function handleV2Fetch(repo: Repo, args: string[]): Buffer {
  const params: FetchParams = { wants: [], haves: [], shallowDeclared: [], deepenNotRefs: [] };
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) params.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) params.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) params.shallowDeclared.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg.startsWith('deepen ')) {
      const depth = Number(arg.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) params.depth = depth;
    } else if (arg.startsWith('deepen-since ')) {
      const since = Number(arg.slice(13).trim());
      if (Number.isFinite(since)) params.since = since;
    } else if (arg.startsWith('deepen-not ')) {
      params.deepenNotRefs.push(arg.slice(11).trim());
    }
    // thin-pack, no-progress, ofs-delta, include-tag, filter and friends are accepted and ignored.
  }
  if (!done) {
    // A negotiation round: the client sent haves but is not done yet. The
    // response is ONLY the acknowledgments section — sending a packfile
    // section here makes git die ("expected no other sections to be sent
    // after no 'ready'"). ACK the haves the server shares with the wants so
    // the client can finish negotiating, and mark the last one ready.
    const lookup = lookupOf(repo);
    const reachable = collectClosure(lookup, params.wants).included;
    const common = params.haves.filter((have) => reachable.has(have));
    const lines: Buffer[] = [pktLine('acknowledgments\n')];
    if (common.length === 0) {
      lines.push(pktLine('NAK\n'));
    } else {
      common.forEach((have, index) => {
        lines.push(pktLine(index === common.length - 1 ? `ACK ${have} ready\n` : `ACK ${have}\n`));
      });
    }
    lines.push(FLUSH_PACKET);
    return Buffer.concat(lines);
  }
  const result = computeFetch(repo, params);
  // A done response carries NO acknowledgments section: negotiation is over
  // (git's client expects the packfile section next and dies if
  // acknowledgments appear here). The acknowledgments section exists only in
  // the negotiation-round responses above.
  const parts: Buffer[] = [];
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PACKET);
  }
  parts.push(pktLine('packfile\n'), sideband(result.pack, 1), FLUSH_PACKET);
  return Buffer.concat(parts);
}

function handleV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const first = packets[0];
  if (first === undefined || first.kind !== 'data') throw new GitError('protocol v2 request has no command line');
  const commandLine = textOf(first.payload).replace(/\n$/, '');
  const match = /^command=([a-z-]+)$/.exec(commandLine);
  if (match === null) throw new GitError(`protocol v2 request starts with ${JSON.stringify(commandLine)}`);
  const command = match[1];
  // The request header lines run to the delim; the arguments run to the flush.
  let index = 1;
  while (index < packets.length && packets[index].kind !== 'delim' && packets[index].kind !== 'flush') index += 1;
  if (index < packets.length && packets[index].kind === 'delim') index += 1;
  const args: string[] = [];
  while (index < packets.length && packets[index].kind === 'data') {
    args.push(textOf(packets[index].payload).replace(/\n$/, ''));
    index += 1;
  }
  if (command === 'ls-refs') return handleLsRefs(repo, args);
  if (command === 'fetch') return handleV2Fetch(repo, args);
  throw new GitError(`unsupported protocol v2 command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------
// protocol v0 upload-pack
// ---------------------------------------------------------------------------

function handleV0Fetch(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const params: FetchParams = { wants: [], haves: [], shallowDeclared: [], deepenNotRefs: [] };
  let sideBand = false;
  let done = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = textOf(packet.payload).replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        const oid = space < 0 ? rest : rest.slice(0, space);
        params.wants.push(oid);
        const caps = space < 0 ? '' : rest.slice(space + 1);
        if (caps.includes('side-band-64k') || caps.includes('side-band')) sideBand = true;
      } else if (line.startsWith('shallow ')) {
        params.shallowDeclared.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const depth = Number(line.slice(7).trim());
        if (Number.isInteger(depth) && depth > 0) params.depth = depth;
      } else if (line.startsWith('deepen-since ')) {
        const since = Number(line.slice(13).trim());
        if (Number.isFinite(since)) params.since = since;
      } else if (line.startsWith('deepen-not ')) {
        params.deepenNotRefs.push(line.slice(11).trim());
      }
    } else if (line.startsWith('have ')) {
      params.haves.push(line.slice(5).trim());
    } else if (line === 'done') {
      done = true;
    }
  }
  if (params.wants.length === 0) throw new GitError('upload-pack request has no want lines');
  if (!done) {
    // A negotiation round: git sends wants + a batch of haves and waits for
    // ACKs before sending done. The response is ONLY the ACK/NAK lines —
    // sending the pack here makes the client read pack bytes as ACK/NAK.
    const lookup = lookupOf(repo);
    const reachable = collectClosure(lookup, params.wants).included;
    const common = params.haves.filter((have) => reachable.has(have));
    const lines: Buffer[] = [];
    if (common.length === 0) {
      lines.push(pktLine('NAK\n'));
    } else {
      common.forEach((have, index) => {
        lines.push(pktLine(index === common.length - 1 ? `ACK ${have} ready\n` : `ACK ${have}\n`));
      });
    }
    lines.push(FLUSH_PACKET);
    return Buffer.concat(lines);
  }
  const result = computeFetch(repo, params);
  const header: Buffer[] = [];
  for (const oid of result.shallow) header.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) header.push(pktLine(`unshallow ${oid}\n`));
  header.push(pktLine('NAK\n'));
  if (sideBand) {
    return Buffer.concat([...header, sideband(result.pack, 1), FLUSH_PACKET]);
  }
  return Buffer.concat([...header, result.pack]);
}

export function handleUploadPack(
  repo: Repo | undefined,
  repoName: string,
  protocolHeader: string | undefined,
  body: Buffer,
): GitResponse {
  if (repo === undefined) return notFoundResponse(repoName);
  try {
    const result = protocolHeader?.includes('version=2') ? handleV2(repo, body) : handleV0Fetch(repo, body);
    return { status: 200, contentType: UPLOAD_RESULT, body: result };
  } catch (err) {
    if (err instanceof GitError) return jsonResponse(400, { message: err.message });
    return jsonResponse(500, { message: 'internal error processing upload-pack request' });
  }
}

// ---------------------------------------------------------------------------
// protocol v0 receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: ReturnType<typeof decodePackets>['packets']): { commands: PushCommand[]; caps: string } {
  const commands: PushCommand[] = [];
  let caps = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = textOf(packet.payload).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul < 0 ? line : line.slice(0, nul);
    if (first && nul >= 0) caps = line.slice(nul + 1);
    first = false;
    const parts = text.split(' ');
    if (parts.length !== 3) throw new GitError(`push command ${JSON.stringify(text)} is not <old> <new> <ref>`);
    const [oldOid, newOid, ref] = parts;
    if (!isOid(oldOid) || !isOid(newOid)) throw new GitError(`push command ${JSON.stringify(text)} has a bad object id`);
    if (!ref.startsWith('refs/')) throw new GitError(`push command names ${JSON.stringify(ref)}, which is not a ref`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new GitError('receive-pack request has no commands');
  return { commands, caps };
}

function reportResponse(lines: string[], useSideBand: boolean): GitResponse {
  // The report-status stream is pkt-line framed. Inside band 1 it must end
  // with its own flush packet: git's status reader reads pkt-lines until a
  // flush, and dies with "the remote end hung up" on EOF instead. The outer
  // flush then terminates the sideband stream itself.
  const report = encodePackets([...lines.map((line) => `${line}\n`), 'flush']);
  const body = useSideBand ? Buffer.concat([sideband(report, 1), FLUSH_PACKET]) : report;
  return { status: 200, contentType: RECEIVE_RESULT, body };
}

export function handleReceivePack(repo: Repo | undefined, repoName: string, body: Buffer): GitResponse {
  if (repo === undefined) return notFoundResponse(repoName);
  try {
    const { packets, offset } = decodePackets(body, true);
    const { commands, caps } = parsePushCommands(packets);
    const useSideBand = caps.includes('side-band-64k') || caps.includes('side-band');
    const packBytes = body.subarray(offset);
    let unpacked = new Map<string, GitObject>();
    if (packBytes.length > 0) {
      try {
        unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
      } catch (err) {
        const detail = err instanceof GitError ? err.message : 'pack did not parse';
        const lines = [`unpack ${detail}`, ...commands.map((command) => `ng ${command.ref} unpack failed`)];
        return reportResponse(lines, useSideBand);
      }
    }
    // Objects from the pack are stored before ref evaluation and stay stored
    // even for refused refs, exactly as git behaves.
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    const lookup = lookupOf(repo);
    const lines: string[] = ['unpack ok'];
    for (const command of commands) {
      const { oldOid, newOid, ref } = command;
      const current = repo.refs.get(ref);
      const refuse = (reason: string): void => {
        lines.push(`ng ${ref} ${reason}`);
      };
      const accept = (): void => {
        if (newOid === ZERO_OID) repo.refs.delete(ref);
        else repo.refs.set(ref, newOid);
        lines.push(`ok ${ref}`);
      };
      if (newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) refuse('remote ref does not exist');
        else if (oldOid !== current) refuse('old value does not match the current value');
        else accept();
        continue;
      }
      const target = lookup(newOid);
      if (target === undefined) {
        refuse('object not found');
        continue;
      }
      if (ref.startsWith('refs/heads/') && target.type !== 'commit') {
        refuse('object is not a commit');
        continue;
      }
      if (oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          refuse(ref.startsWith('refs/tags/') ? 'tag already exists' : 'already exists');
        } else {
          accept();
        }
        continue;
      }
      // Update.
      if (current === undefined) {
        refuse('remote ref does not exist');
        continue;
      }
      if (ref.startsWith('refs/tags/')) {
        refuse('tag already exists');
        continue;
      }
      if (oldOid !== current) {
        refuse('old value does not match the current value');
        continue;
      }
      if (!isAncestor(lookup, oldOid, newOid)) {
        refuse('non-fast-forward');
        continue;
      }
      accept();
    }
    return reportResponse(lines, useSideBand);
  } catch (err) {
    if (err instanceof GitError) return jsonResponse(400, { message: err.message });
    return jsonResponse(500, { message: 'internal error processing receive-pack request' });
  }
}

// Re-exported for the REST layer's merge logic, which needs the same graph.
export { mergeBase, FIXED_ISO };
