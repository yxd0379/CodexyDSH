/** Product-owned durable Session provider; DSH Session and handle protocols remain unmodified. */
import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, stat, link, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import lockfile from 'proper-lockfile'
import {
  SessionPersistence, SessionPersistenceRevision, SessionPersistenceNotFoundError,
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionReadOnlyError,
  SessionOwnershipLostError, SessionHandleClosedError, SessionPersistenceCorruptionError,
  materializeCreateHeader, materializeAppendBatch, assertContiguous,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionHandle, SessionAccess, SessionPersistenceCreateOptions, SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot, SessionPersistenceStatOptions, SessionPersistenceListOptions,
  SessionHandleReadOptions, SessionHandleAppendOptions, SessionHandleFlushOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  CODEXY_ARTIFACT_VERSION, decodeArtifactHeader, decodeCodexyArtifact, encodeArtifactHeader, encodeArtifactEvents,
  validateCodexyEvents, validateCodexyBatch,
} from './persistence-codec.ts'
import type { CodexyArtifactHeader } from './persistence-codec.ts'

/** Session storage directory and bounded lease timing, shared by every writer of the directory. */
export interface PersistenceConfig { root: string; leaseStaleMs: number; leaseUpdateMs: number }
function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
/** Synchronize directory metadata where the host supports directory fsync. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
/** Read immutable metadata without decoding the conversation body. */
async function readArtifactMetadata(path: string): Promise<CodexyArtifactHeader> {
  const file = await open(path, 'r')
  const chunks: Buffer[] = []
  let position = 0
  try {
    while (true) {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) throw new TypeError('Codexy Session metadata is incomplete')
      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(10)
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline))
      if (newline >= 0) { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); return decodeArtifactHeader(value) }
      position += bytesRead
    }
  } finally { await file.close() }
}
/** Publish a new artifact without replacing an existing file. */
export async function publishArtifact(path: string, metadata: CodexyArtifactHeader, events: readonly SessionEvent[]): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(encodeArtifactHeader(metadata) + encodeArtifactEvents(events), 'utf8')
      await file.sync()
    } finally { await file.close() }
    await link(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await unlink(temporary) }
}
interface Lease { lost: boolean; release(): Promise<void> }

/** New product storage composes the original SessionPersistence service definition. */
export class CodexySessionPersistence extends SessionPersistence {
  static Config: z<PersistenceConfig> = z.object({
    root: z.string().required(),
    leaseStaleMs: z.number().step(1).min(5000).default(30000),
    leaseUpdateMs: z.number().step(1).min(1000).default(10000),
  })
  override readonly name = 'codexy-session-persistence'
  readonly root: string
  private readonly handles = new Set<ProductSessionHandle>()
  private closing = false
  private readonly operations = new Set<Promise<unknown>>()
  private readonly initialized: Promise<void>

  constructor(ctx: Context, readonly config: PersistenceConfig) {
    super(ctx)
    if (config.leaseUpdateMs > config.leaseStaleMs / 2) throw new TypeError('leaseUpdateMs must not exceed half leaseStaleMs')
    this.root = resolve(config.root)
    this.initialized = this.initialize()
    ctx.effect(async () => { await this.initialized; return () => this.disposeHandles() }, 'codexyPersistence.handles()')
    ctx.on('session/event', (session, event) => this.writer(session.id)?.recordLive(event))
    ctx.on('session/flush', session => this.writer(session.id)?.flush())
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
  }
  /** Read an active, unpublished prefix from its sole local writer. */
  async readPending(id: SessionId): Promise<{ metadata: CodexyArtifactHeader; events: SessionEvent[] } | undefined> {
    const writer = this.writer(id)
    if (writer === undefined || !writer.unmaterialized) return undefined
    const read = await writer.read()
    return { metadata: writer.artifactMetadata, events: read.events }
  }
  private writer(id: SessionId): ProductSessionHandle | undefined {
    return [...this.handles].find(handle => handle.id === id && handle.access === 'write')
  }
  /** Path owned by this product, with an encoded identity and independent container suffix. */
  pathFor(id: SessionId): string { return join(this.root, `${encodeURIComponent(id)}.codexy.jsonl`) }
  private async acquire(path: string, id: SessionId): Promise<Lease> {
    const lease: Lease = { lost: false, release: async () => {} }
    try {
      lease.release = await lockfile.lock(path, {
        realpath: false, retries: 0, stale: this.config.leaseStaleMs, update: this.config.leaseUpdateMs,
        onCompromised: () => { lease.lost = true },
      })
    } catch (error: unknown) {
      if (errno(error, 'ELOCKED')) throw new SessionAlreadyOwnedError(id)
      throw error
    }
    return lease
  }
  private own<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Codexy persistence is disposing'))
    const pending = this.initialized.then(operation)
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
  override create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.own(async () => {
      options?.signal?.throwIfAborted()
      const meta = materializeCreateHeader(header)
      const path = this.pathFor(meta.id)
      const lease = await this.acquire(path, meta.id)
      try {
        options?.signal?.throwIfAborted()
        const inheritedEventCount = options?.inheritedEventCount ?? SessionLogOffset(0)
        if (!meta.isSeeded && inheritedEventCount !== 0) throw new TypeError('unseeded Session cannot have inherited events')
        if (meta.isSeeded && options?.inheritedEventCount === undefined) throw new TypeError('seeded Session requires inheritedEventCount')
        const metadata: CodexyArtifactHeader = { kind: 'codexy-session', version: CODEXY_ARTIFACT_VERSION, session: meta, inheritedEventCount }
        try { await stat(path); throw new SessionAlreadyExistsError(meta.id) } catch (error: unknown) {
          if (!errno(error, 'ENOENT')) throw error
        }
        const handle = ProductSessionHandle.created(this, path, metadata, lease)
        this.handles.add(handle)
        return handle
      } catch (error: unknown) {
        await lease.release()
        throw error
      }
    })
  }
  override open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.own(async () => {
      options?.signal?.throwIfAborted()
      const path = this.pathFor(id)
      let lease: Lease | undefined
      try {
        if (access === 'write') lease = await this.acquire(path, id)
        const decoded = decodeCodexyArtifact(await readFile(path))
        if (decoded.metadata.session.id !== id) throw new TypeError('stored Session identity differs from requested identity')
        options?.signal?.throwIfAborted()
        const handle = await ProductSessionHandle.open(this, path, access, decoded, lease)
        this.handles.add(handle)
        return handle
      } catch (error: unknown) {
        await lease?.release()
        if (errno(error, 'ENOENT')) {
          const pending = access === 'read' ? await this.readPending(id) : undefined
          if (pending !== undefined) {
            const handle = ProductSessionHandle.pendingReader(this, path, pending)
            this.handles.add(handle)
            return handle
          }
          throw new SessionPersistenceNotFoundError(id)
        }
        throw error
      }
    })
  }
  override async flush(): Promise<void> {
    await this.initialized
    const results = await Promise.allSettled([...this.handles].filter(handle => handle.access === 'write').map(handle => handle.flush()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Codexy Session flush failed')
  }
  override stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    return this.own(async () => {
      options?.signal?.throwIfAborted()
      const path = this.pathFor(id)
      try {
        const metadata = await readArtifactMetadata(path)
        if (metadata.session.id !== id) throw new TypeError('stored Session identity differs from requested identity')
        const identity = await stat(path, { bigint: true })
        options?.signal?.throwIfAborted()
        return { header: metadata.session, sizeBytes: Number(identity.size),
          revision: SessionPersistenceRevision(`${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`) }
      } catch (error: unknown) {
        if (errno(error, 'ENOENT')) {
          const pending = await this.readPending(id)
          return pending === undefined ? undefined : { header: pending.metadata.session, eventCount: pending.events.length,
            sizeBytes: 0, revision: SessionPersistenceRevision(`pending:${id}:${pending.events.length}`) }
        }
        throw error
      }
    })
  }
  override list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.own(async () => {
      const names = await readdir(this.root)
      const snapshots: SessionPersistenceSnapshot[] = []
      const ids = new Set([...this.handles].filter(handle => handle.access === 'write').map(handle => handle.id))
      for (const name of names) if (name.endsWith('.codexy.jsonl')) ids.add(SessionId(decodeURIComponent(name.slice(0, -'.codexy.jsonl'.length))))
      for (const id of ids) {
        options?.signal?.throwIfAborted()
        const snapshot = await this.stat(id, options)
        if (snapshot !== undefined) snapshots.push(snapshot)
      }
      return snapshots
    })
  }
  /** Remove one closed handle from process-local lifecycle ownership. */
  forget(handle: ProductSessionHandle): void { this.handles.delete(handle) }
  private async disposeHandles(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.operations])
    const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Codexy Session disposal failed')
  }
}

/** One serialized handle holding a portable lease for its complete write lifetime. */
class ProductSessionHandle implements SessionHandle {
  private state: 'open' | 'closing' | 'closed' = 'open'
  private queue: Promise<void> = Promise.resolve()
  private closed: Promise<void> | undefined
  private writeFailure: unknown
  private observedCount = 0
  private validBytes = 0
  private tornBytes = 0
  private events: SessionEvent[] = []
  private file: FileHandle | undefined
  private constructor(private readonly owner: CodexySessionPersistence, private readonly path: string,
    readonly access: SessionAccess, private readonly metadata: CodexyArtifactHeader,
    private readonly lease: Lease | undefined) {}
  get unmaterialized(): boolean { return this.file === undefined }
  get artifactMetadata(): CodexyArtifactHeader { return this.metadata }
  get id(): SessionId { return this.metadata.session.id }
  get header(): SessionHeader { return this.metadata.session }
  get inheritedEventCount(): SessionLogOffset { return this.metadata.inheritedEventCount }
  static created(owner: CodexySessionPersistence, path: string, metadata: CodexyArtifactHeader, lease: Lease): ProductSessionHandle {
    return new ProductSessionHandle(owner, path, 'write', metadata, lease)
  }
  static pendingReader(owner: CodexySessionPersistence, path: string,
    snapshot: { metadata: CodexyArtifactHeader; events: SessionEvent[] }): ProductSessionHandle {
    const handle = new ProductSessionHandle(owner, path, 'read', snapshot.metadata, undefined)
    handle.events = snapshot.events
    handle.observedCount = snapshot.events.length
    return handle
  }
  static async open(owner: CodexySessionPersistence, path: string, access: SessionAccess,
    decoded: ReturnType<typeof decodeCodexyArtifact>, lease?: Lease): Promise<ProductSessionHandle> {
    const handle = new ProductSessionHandle(owner, path, access, decoded.metadata, lease)
    if (access === 'write') handle.file = await open(path, 'r+')
    handle.events = decoded.events
    handle.observedCount = decoded.events.length
    handle.validBytes = decoded.validBytes
    handle.tornBytes = decoded.tornBytes
    return handle
  }
  private check(operation: string, write: boolean): void {
    if (this.state !== 'open') throw new SessionHandleClosedError(this.id, operation)
    if (write && this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
    if (this.lease?.lost === true) throw new SessionOwnershipLostError(this.id)
    if (this.writeFailure !== undefined) throw this.writeFailure
  }
  private schedule<T>(operation: string, write: boolean, run: () => Promise<T>): Promise<T> {
    try { this.check(operation, write) } catch (error: unknown) { return Promise.reject(error) }
    const pending = this.queue.then(async () => {
      if (this.lease?.lost === true) throw new SessionOwnershipLostError(this.id)
      if (this.writeFailure !== undefined) throw this.writeFailure
      return run()
    })
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }
  read(offset = 0, length?: number, options?: SessionHandleReadOptions) {
    return this.schedule('read', false, async () => {
      options?.signal?.throwIfAborted()
      if (!Number.isSafeInteger(offset) || offset < 0 || length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new TypeError('Session read range must contain nonnegative safe integers')
      // A write lease owns the cached prefix; readers refresh from the complete on-disk prefix.
      if (this.access === 'read') {
        let refreshed: SessionEvent[]
        try { refreshed = decodeCodexyArtifact(await readFile(this.path)).events } catch (error: unknown) {
          if (!errno(error, 'ENOENT')) throw error
          const pending = await this.owner.readPending(this.id)
          if (pending === undefined) throw new SessionPersistenceNotFoundError(this.id)
          refreshed = pending.events
        }
        if (refreshed.length < this.observedCount) throw new SessionPersistenceCorruptionError('Session read moved behind its observed prefix', {})
        this.events = refreshed
        this.observedCount = refreshed.length
      }
      options?.signal?.throwIfAborted()
      return { eventState: 'detached' as const, events: structuredClone(this.events.slice(offset, length === undefined ? undefined : offset + length)) }
    })
  }
  recordLive(event: SessionEvent): Promise<void> {
    const pending = this.append([event]).catch((error: unknown) => { this.writeFailure = error; throw error })
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    const detached = [...materializeAppendBatch(events)]
    return this.schedule('append', true, async () => {
      options?.signal?.throwIfAborted()
      assertContiguous(this.id, detached, this.events.length)
      validateCodexyBatch(detached)
      if (detached.length === 0) return
      try {
        if (this.file === undefined) {
          validateCodexyEvents(this.metadata, detached)
          await publishArtifact(this.path, this.metadata, detached)
          this.file = await open(this.path, 'r+')
          this.validBytes = Buffer.byteLength(encodeArtifactHeader(this.metadata) + encodeArtifactEvents(detached))
        } else {
          if (this.tornBytes > 0) { await this.file.truncate(this.validBytes); this.tornBytes = 0 }
          const data = Buffer.from(encodeArtifactEvents(detached))
          let written = 0
          while (written < data.length) {
            if (this.lease?.lost === true) throw new SessionOwnershipLostError(this.id)
            const result = await this.file.write(data, written, data.length - written, this.validBytes + written)
            if (result.bytesWritten === 0) throw new Error('Session write made no progress')
            written += result.bytesWritten
          }
          this.validBytes += data.length
        }
        this.events.push(...detached)
        this.observedCount = this.events.length
      } catch (error: unknown) { this.writeFailure = error; throw error }
    })
  }
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.schedule('flush', true, async () => {
      options?.signal?.throwIfAborted()
      if (this.file === undefined) {
        if (this.header.isSeeded) return
        await publishArtifact(this.path, this.metadata, [])
        this.file = await open(this.path, 'r+')
        this.validBytes = Buffer.byteLength(encodeArtifactHeader(this.metadata))
      }
      if (this.tornBytes > 0) { await this.file.truncate(this.validBytes); this.tornBytes = 0 }
      await this.file.datasync()
    })
  }
  close(): Promise<void> {
    if (this.closed !== undefined) return this.closed
    this.state = 'closing'
    this.closed = this.queue.then(async () => {
      try {
        if (this.access === 'write' && this.file === undefined && !this.header.isSeeded && this.lease?.lost !== true && this.writeFailure === undefined) {
          await publishArtifact(this.path, this.metadata, [])
          this.file = await open(this.path, 'r+')
        }
        if (this.file !== undefined && this.lease?.lost !== true && this.writeFailure === undefined) await this.file.datasync()
      } finally {
        try { await this.file?.close() } finally {
          try { await this.lease?.release() } finally { this.state = 'closed'; this.owner.forget(this) }
        }
      }
      if (this.writeFailure !== undefined) throw this.writeFailure
    })
    return this.closed
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }
}
export default CodexySessionPersistence
export * from './persistence-codec.ts'
