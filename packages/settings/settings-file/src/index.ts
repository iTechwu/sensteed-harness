/**
 * File-backed settings provider compat shim. One YAML or JSON document under
 * the harness home carries every namespace section; external edits hot-publish
 * through the seam, and every write re-reads the document under a
 * cross-process writer lock before patching it as a comment-preserving
 * leaf-level diff.
 *
 * Desktop edition fork commit: the 0.1.6 provider face
 * (`register`/`get`/`update`/`replace`/`watch` and the `settings/updated`
 * event) is rebuilt here directly over the file machinery, because the 0.1.7
 * core removed the `SettingsProvider` base this package previously extended.
 * @module @deepseek-ai/dsh-settings-file
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Settings document path; defaults to `settings.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}
type SettingsFormat = 'yaml' | 'json'

interface ResolvedSpec {
  filename: string
  format: SettingsFormat
  watch: boolean
  debounceMs: number
}

const FORMATS: Record<string, SettingsFormat> = { '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json' }

/** Historical scope face exported for Desktop editions. */
export interface SettingsScope<T = unknown> {
  get(): T
  update(patch: Partial<T>): Promise<void>
  replace(section: Partial<T>): Promise<void>
  watch(listener: (next: T) => void): () => void
}

interface ScopeState {
  schema: z
  validate?: ((value: unknown) => void) | undefined
  value: unknown
  listeners: Set<(next: unknown) => void>
}

/** Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the document lives at `<harness home>/settings.yaml`. */
export function resolveSpec(config: Config): ResolvedSpec {
  const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), 'settings.yaml'))
  const format = FORMATS[extname(filename)]
  if (format === undefined) {
    throw new Error(`settings-file: extension "${extname(filename)}" is not supported (use .yaml, .yml, or .json)`)
  }
  return { filename, format, watch: config.watch ?? true, debounceMs: config.debounceMs ?? 100 }
}

function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function patchNode(document: Document, path: readonly string[], current: unknown, next: unknown): void {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  document.setIn([...path], next)
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

export class FileSettingsProvider extends Service {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  private readonly scopes = new Map<string, ScopeState>()
  private sections: Record<string, unknown> = {}
  private text: string | undefined
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'settings')
    this.spec = resolveSpec(config)
  }

  get writable(): boolean {
    return true
  }

  get documentPath(): string {
    return this.spec.filename
  }

  prepareDocument(): Promise<string> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        try {
          await writeFile(this.spec.filename, '', { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (isEEXIST(error)) return
          throw error
        }
        this.text = ''
        if (!this.isClosed()) this.publish({})
      })
      return this.spec.filename
    })
  }

  /** Register one legacy namespaced scope over the shared document. */
  register<T = unknown>(ns: string, schema: z<T>, opts?: { applies?: 'live' | 'restart'; validate?: (value: T) => void }): SettingsScope<T> {
    if (this.scopes.has(ns)) throw new Error(`settings-file: namespace "${ns}" is already registered`)
    const state: ScopeState = {
      schema,
      validate: opts?.validate as ((value: unknown) => void) | undefined,
      value: schema(this.sections[ns] as T),
      listeners: new Set(),
    }
    this.scopes.set(ns, state)
    return {
      get: () => this.scopeValue(ns) as T,
      update: async (patch: Partial<T>) => { await this.scopeWrite(ns, patch, 'update') },
      replace: async (section: Partial<T>) => { await this.scopeWrite(ns, section, 'replace') },
      watch: (listener: (next: T) => void) => {
        state.listeners.add(listener as (next: unknown) => void)
        return () => { state.listeners.delete(listener as (next: unknown) => void) }
      },
    }
  }

  /** Read one registered namespace through its schema. */
  get(ns: string): unknown {
    return this.scopeValue(ns)
  }

  private scopeValue(ns: string): unknown {
    const state = this.scopes.get(ns)
    if (state === undefined) throw new Error(`settings-file: namespace "${ns}" is not registered`)
    return state.value
  }

  private scopeListeners(ns: string): Set<(next: unknown) => void> {
    return this.scopes.get(ns)?.listeners ?? new Set()
  }

  private async scopeWrite(ns: string, input: Record<string, unknown>, mode: 'update' | 'replace'): Promise<void> {
    const state = this.scopes.get(ns)
    if (state === undefined) throw new Error(`settings-file: namespace "${ns}" is not registered`)
    const current = (state.value && typeof state.value === 'object' && !Array.isArray(state.value))
      ? state.value as Record<string, unknown>
      : {}
    const nextInput = mode === 'update' ? { ...current, ...input } : input
    const value: unknown = state.schema(nextInput)
    state.validate?.(value)
    await this.persist(ns, value as Record<string, unknown>)
    state.value = value
    for (const listener of this.scopeListeners(ns)) listener(value)
  }

  /** Announce the standing document into every registered scope. */
  private publish(document: Record<string, unknown>): void {
    this.sections = document
    for (const [ns, state] of this.scopes) {
      const value: unknown = state.schema(document[ns] ?? {})
      if (deepEqualJson(value, state.value)) continue
      state.value = value
      for (const listener of state.listeners) listener(value)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private queueRefresh(): void {
    void this.enqueue(() => this.refresh()).catch((error: unknown) => {
      this.ctx.logger.error('settings-file: reload commit failed at %s', this.spec.filename)
      this.ctx.logger.error(error)
    })
  }

  protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
    return this.enqueue(() => this.persistSection(ns, section))
  }

  private async persistSection(ns: string, section: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.spec.filename, async () => {
      await this.reconcileFromDisk()
      const output = this.spec.format === 'yaml'
        ? this.renderYaml(ns, section)
        : this.renderJson(ns, section)
      await writeFileAtomic(this.spec.filename, output, { mode: 0o600, dirMode: 0o700 })
      this.text = output
    })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    const initial = await this.loadDocument()
    this.publish(initial)
    const watcher = this.spec.watch
      ? chokidarWatch(await canonicalizeWatchPath(this.spec.filename), {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.spec.debounceMs,
          pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
        },
      })
      : undefined
    if (watcher !== undefined) {
      watcher.on('all', () => {
        if (this.closed) return
        this.queueRefresh()
      })
      watcher.on('ready', () => {
        if (this.closed) return
        this.queueRefresh()
      })
      watcher.on('error', (error) => {
        this.ctx.logger.warn('settings-file: watcher error on %s', this.spec.filename)
        this.ctx.logger.warn(error)
      })
    }
    yield async () => {
      this.closed = true
      await watcher?.close()
      await this.operations
    }
  }

  private async loadDocument(): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.text = undefined
      return {}
    }
    const doc = this.parse(text)
    this.text = text
    return doc
  }

  private parse(text: string): Record<string, unknown> {
    let root: unknown
    if (this.spec.format === 'yaml') {
      const document = parseDocument(text, { prettyErrors: true })
      if (document.errors.length > 0) {
        throw new Error(`settings-file: invalid document at ${this.spec.filename}: ${
          document.errors.map((error) => {
            const at = error.linePos?.[0]
            return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
          }).join('; ')}`)
      }
      root = document.toJS() ?? {}
    } else {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new TypeError(`settings-file: ${this.spec.filename} must be a map of namespace sections`)
    }
    return root as Record<string, unknown>
  }

  private async refresh(): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.ctx.logger.warn('settings-file: reload failed at %s; keeping the last good document', this.spec.filename)
      this.ctx.logger.warn(error)
    }
  }

  private async reconcileFromDisk(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text || this.isClosed()) return
    if (text === undefined) {
      this.text = undefined
      this.publish({})
      return
    }
    const doc = this.parse(text)
    this.text = text
    this.publish(doc)
  }

  private renderYaml(ns: string, section: Record<string, unknown>): string {
    if (this.text === undefined) {
      return new Document({ [ns]: section }).toString()
    }
    const document = parseDocument(this.text)
    const root: unknown = document.toJS()
    patchNode(document, [ns], isMapLike(root) ? root[ns] : undefined, section)
    return document.toString()
  }

  private renderJson(ns: string, section: Record<string, unknown>): string {
    const root = this.text === undefined
      ? {}
      : this.parse(this.text)
    root[ns] = section
    return `${JSON.stringify(root, null, 2)}\n`
  }
}

export default FileSettingsProvider
