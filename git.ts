// The git core: object model, packfile codec, pkt-line framing and the graph
// algorithms the smart-HTTP surface needs. Everything here is the public git
// format as documented in git's own technical docs (pack-protocol,
// protocol-v2, pack-format); no git binary is involved anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** Malformed git data (a bad pack, a corrupt object, a broken pkt-line stream). */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;
/** The largest payload a sideband packet can carry: the pkt-line cap less the length field and band byte. */
export const SIDEBAND_CHUNK = PKT_LINE_MAX - 5;

export const FLUSH_PACKET = Buffer.from('0000', 'ascii');
export const DELIM_PACKET = Buffer.from('0001', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buf`. Throws GitError on a malformed or truncated
 * stream. Returns the packets and the offset just past the last one consumed.
 * When `stopAfterFlush` is set, decoding stops after the first flush packet
 * and the offset points at the raw bytes that follow it (a receive-pack pack).
 */
export function decodePackets(buf: Buffer, stopAfterFlush = false): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new GitError(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new GitError(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAfterFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new GitError(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new GitError(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

/** Encode a mixed sequence; 'flush' and 'delim' are the control packets. */
export function encodePackets(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH_PACKET);
    else if (item === 'delim') parts.push(DELIM_PACKET);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Frame `data` as sideband packets on `band`, chunked to the pkt-line cap. */
export function sideband(data: Buffer, band: 1 | 2 | 3): Buffer {
  if (data.length === 0) return pktLine(Buffer.from([band]));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitError('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new GitError('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitError(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** The committer timestamp (unix seconds), 0 when the header does not parse. */
  committerTime: number;
}

/** Parse a commit object. Extra headers (gpgsig, encoding, ...) are tolerated and dropped. */
export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new GitError('commit has no valid tree header');
  for (const parent of parents) if (!isOid(parent)) throw new GitError('commit has a bad parent id');
  let committerTime = 0;
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  if (match) committerTime = Number(match[1]);
  return { tree, parents, author, committer, message, committerTime };
}

/**
 * Build a commit object's bytes. `author` and `committer` are full ident lines
 * (`Name <email> timestamp timezone`); `message` is used byte for byte.
 */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new GitError('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitError(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream starting at `offset` (bounded by `end`); answers its bytes and the offset just past it. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten?: unknown } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: unknown } };
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (typeof written !== 'number' || written <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new GitError('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new GitError(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new GitError('delta insert is truncated');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new GitError(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA entries. `resolveBase` supplies a base object a
 * thin pack leaves out (an object the store already holds). Every object's
 * SHA-1 is recomputed; the trailer checksum is verified. Throws GitError on
 * any corruption.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new GitError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new GitError('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new GitError('pack entry header is truncated');
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new GitError('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new GitError('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: the base offset is a variable-length negative offset.
      if (offset >= trailerStart) throw new GitError('ofs-delta has no base offset');
      byte = pack[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new GitError('ofs-delta base offset is truncated');
        byte = pack[offset++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new GitError(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by object id.
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitError(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new GitError(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new GitError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new GitError(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint the pack format uses. */
function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas: every object is stored
 * whole, which git accepts and keeps pack generation fast). The order is the
 * caller's; the trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The empty pack: a 12-byte header, 0 entries, and its SHA-1 trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ---------------------------------------------------------------------------
// graph algorithms
// ---------------------------------------------------------------------------

export type Lookup = (oid: string) => GitObject | undefined;

export interface ClosureOptions {
  /** Max commit generations from the roots (a `deepen` limit). Unset means no limit. */
  depth?: number;
  /** `deepen-since`: only commits at or after this committer time are included. */
  since?: number;
  /** `deepen-not`: commits in this set (and their ancestors) are excluded. */
  exclude?: ReadonlySet<string>;
  /**
   * Shallow boundaries the client declared: included with their trees, but
   * their parents are not traversed (the client's closure is truncated there).
   */
  stopAt?: ReadonlySet<string>;
}

export interface ClosureResult {
  /** Every object id in the closure (commits, tags, trees, blobs). */
  included: Set<string>;
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree ->
 * entries (gitlinks skipped), tag -> its target. Depth, since, exclude and
 * stopAt narrow the walk as the fetch protocol requires. Objects missing
 * from the store are skipped silently: a fetch never fails on a stale have.
 */
export function collectClosure(lookup: Lookup, roots: Iterable<string>, options: ClosureOptions = {}): ClosureResult {
  const included = new Set<string>();
  const commitGen = new Map<string, number>();
  interface Work {
    oid: string;
    gen: number;
  }
  const queue: Work[] = [];
  for (const root of roots) {
    if (isOid(root)) queue.push({ oid: root, gen: 1 });
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, gen } = queue[head++];
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const seen = commitGen.get(oid);
      if (seen !== undefined && seen <= gen) continue;
      if (options.exclude?.has(oid)) continue;
      let info: CommitInfo;
      try {
        info = parseCommit(object.data);
      } catch {
        continue;
      }
      if (options.since !== undefined && info.committerTime < options.since) continue;
      if (options.depth !== undefined && gen > options.depth) continue;
      commitGen.set(oid, gen);
      included.add(oid);
      queue.push({ oid: info.tree, gen });
      if (!options.stopAt?.has(oid)) {
        for (const parent of info.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (object.type === 'tag') {
      if (included.has(oid)) continue;
      included.add(oid);
      let info: TagInfo;
      try {
        info = parseTag(object.data);
      } catch {
        continue;
      }
      queue.push({ oid: info.object, gen });
    } else if (object.type === 'tree') {
      if (included.has(oid)) continue;
      included.add(oid);
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, gen });
      }
    } else {
      included.add(oid);
    }
  }
  return { included };
}

/**
 * The shallow boundaries of a fetch: commits in `included` that have a
 * parent present in the store but cut out of the closure (by depth, time or
 * exclusion). Root commits are never boundaries.
 */
export function shallowBoundaries(lookup: Lookup, included: ReadonlySet<string>): string[] {
  const boundaries: string[] = [];
  for (const oid of included) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    let info: CommitInfo;
    try {
      info = parseCommit(object.data);
    } catch {
      continue;
    }
    if (info.parents.length === 0) continue;
    const cut = info.parents.some((parent) => !included.has(parent) && lookup(parent) !== undefined);
    if (cut) boundaries.push(oid);
  }
  return boundaries;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(lookup: Lookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    let info: CommitInfo;
    try {
      info = parseCommit(object.data);
    } catch {
      continue;
    }
    for (const parent of info.parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge base of two commits: the nearest common ancestor. The walk is a
 * breadth-first search from `b` over the ancestor set of `a`, which is exact
 * for the linear histories forks produce and a reasonable nearest ancestor
 * otherwise. Null when the histories share nothing.
 */
export function mergeBase(lookup: Lookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    } catch {
      // A corrupt commit ends this branch of the walk.
    }
  }
  const seen = new Set<string>();
  const queueB = [b];
  let head = 0;
  while (head < queueB.length) {
    const oid = queueB[head++];
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    try {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    } catch {
      // A corrupt commit ends this branch of the walk.
    }
  }
  return null;
}

/** Follow tag objects until a non-tag object; a tag cycle answers the last tag seen. */
export function peelToNonTag(lookup: Lookup, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    try {
      current = parseTag(object.data).object;
    } catch {
      return current;
    }
  }
}

/** Peel tags to a commit, or null when the chain ends at another object type. */
export function peelToCommit(lookup: Lookup, oid: string): string | null {
  const peeled = peelToNonTag(lookup, oid);
  const object = lookup(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : null;
}

// ---------------------------------------------------------------------------
// trees as file maps, diffs and merges
// ---------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into path -> entry. Gitlinks are kept with mode 160000. */
export function flattenTree(lookup: Lookup, treeOid: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/**
 * Build a tree object from a flat file map, writing every new tree object
 * through `put`. Throws GitError when a path is both a file and a directory.
 */
export function treeFromMap(put: (type: ObjType, data: Buffer) => string, files: ReadonlyMap<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  const sortedPaths = [...files.keys()].sort();
  for (const path of sortedPaths) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (node.files.has(name)) throw new GitError(`path ${JSON.stringify(path)} conflicts with a file of the same name`);
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    const leaf = segments[segments.length - 1];
    if (node.dirs.has(leaf)) throw new GitError(`path ${JSON.stringify(path)} conflicts with a directory of the same name`);
    node.files.set(leaf, files.get(path) as FileEntry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Set (`newOid` non-null) or delete (`newOid` null) one path in a tree,
 * writing every changed tree object through `put` and pruning directories
 * left empty. `baseTreeOid` may be null for an empty tree. Throws GitError
 * when a path segment crosses a file.
 */
export function updateTreePath(
  lookup: Lookup,
  put: (type: ObjType, data: Buffer) => string,
  baseTreeOid: string | null,
  segments: readonly string[],
  newOid: string | null,
  mode: string,
): string {
  const rewrite = (treeOid: string | null, depth: number): string | null => {
    let entries: TreeEntry[] = [];
    if (treeOid !== null) {
      const object = lookup(treeOid);
      if (object !== undefined && object.type === 'tree') entries = parseTree(object.data);
    }
    const name = segments[depth];
    const last = depth === segments.length - 1;
    const kept: TreeEntry[] = [];
    let found = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        kept.push(entry);
        continue;
      }
      found = true;
      if (last) {
        if (newOid !== null) {
          if (entry.mode === '40000') throw new GitError(`path ${JSON.stringify(segments.join('/'))} is a directory`);
          kept.push({ mode, name, oid: newOid });
        }
        // Deleting: the entry is dropped.
      } else {
        if (entry.mode !== '40000') throw new GitError(`path segment ${JSON.stringify(name)} is a file, not a directory`);
        const child = rewrite(entry.oid, depth + 1);
        if (child !== null) kept.push({ mode: '40000', name, oid: child });
      }
    }
    if (!found) {
      if (newOid === null) return entries.length === 0 ? null : put('tree', buildTree(entries));
      if (last) {
        kept.push({ mode, name, oid: newOid });
      } else {
        const child = rewrite(null, depth + 1);
        if (child !== null) kept.push({ mode: '40000', name, oid: child });
      }
    }
    if (kept.length === 0) return null;
    return put('tree', buildTree(kept));
  };
  return rewrite(baseTreeOid, 0) ?? put('tree', buildTree([]));
}

/** The length of the longest common subsequence of two line lists. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  // Trim the common prefix and suffix first: most edits are small.
  let startA = 0;
  let startB = 0;
  let endA = a.length;
  let endB = b.length;
  while (startA < endA && startB < endB && a[startA] === b[startB]) {
    startA += 1;
    startB += 1;
  }
  while (endA > startA && endB > startB && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const prefix = startA;
  const suffix = a.length - endA;
  const n = endA - startA;
  const m = endB - startB;
  if (n === 0 || m === 0) return prefix + suffix;
  if (n * m > 2_000_000) {
    // Too large for the quadratic table: count the whole middle as changed.
    return prefix + suffix;
  }
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[startA + i - 1] === b[startB + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prefix + suffix + prev[m];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blob contents (null = absent). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : splitLines(oldData.toString('utf8'));
  const newLines = newData === null ? [] : splitLines(newData.toString('utf8'));
  const common = lcsLength(oldLines, newLines);
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Diff two trees (null = the empty tree) into per-file entries, sorted by path. */
export function diffTrees(lookup: Lookup, oldTree: string | null, newTree: string | null): DiffEntry[] {
  const oldFiles = oldTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, oldTree);
  const newFiles = newTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, newTree);
  const paths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  const entries: DiffEntry[] = [];
  for (const path of paths) {
    const old = oldFiles.get(path);
    const next = newFiles.get(path);
    if (old !== undefined && next !== undefined && old.oid === next.oid && old.mode === next.mode) continue;
    const blobOf = (entry: FileEntry | undefined): Buffer | null => {
      if (entry === undefined || entry.mode === '160000') return null;
      const object = lookup(entry.oid);
      return object !== undefined && object.type === 'blob' ? object.data : null;
    };
    if (old === undefined && next !== undefined) {
      const counts = lineDiff(null, blobOf(next));
      entries.push({ path, status: 'added', oldOid: null, newOid: next.oid, additions: counts.additions, deletions: 0 });
    } else if (old !== undefined && next === undefined) {
      const counts = lineDiff(blobOf(old), null);
      entries.push({ path, status: 'removed', oldOid: old.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (old !== undefined && next !== undefined) {
      const counts = next.mode === '160000' || old.mode === '160000' ? { additions: 0, deletions: 0 } : lineDiff(blobOf(old), blobOf(next));
      entries.push({ path, status: 'modified', oldOid: old.oid, newOid: next.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export type MergeOutcome =
  | { merged: Map<string, FileEntry>; conflicts: [] }
  | { merged: null; conflicts: string[] };

/**
 * A three-way file-level merge: `base` is the merge-base tree, `ours` and
 * `theirs` the two tips. A path changed on one side only takes that side; a
 * path changed on both sides to different contents conflicts, as do add/add
 * with different contents and delete/modify. Returns the merged file map or
 * the conflicting paths.
 */
export function threeWayMerge(
  lookup: Lookup,
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): MergeOutcome {
  const base = baseTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, baseTree);
  const ours = oursTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, oursTree);
  const theirs = theirsTree === null ? new Map<string, FileEntry>() : flattenTree(lookup, theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FileEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FileEntry | undefined, y: FileEntry | undefined): boolean =>
      x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { merged: null, conflicts: conflicts.sort() };
  return { merged, conflicts: [] };
}
