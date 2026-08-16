import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1_000

/** 会话 id 到归档时间（Unix epoch 毫秒）的持久化映射。 */
export type ArchivedAtMap = Readonly<Record<string, number>>

/** 归档时间持久化后端。 */
export interface ArchiveTimeStore {
  /** 读取完整归档时间映射。 */
  read: () => Promise<Record<string, number>>
  /** 原子替换完整归档时间映射。 */
  write: (archivedAt: ArchivedAtMap) => Promise<void>
}

/** 一次归档集合变化的输入。 */
export interface ArchiveTimeReconcileInput {
  previousArchivedIds: readonly string[]
  nextArchivedIds: readonly string[]
  archivedAt: ArchivedAtMap
  now: number
}

/** 一次归档集合变化的结果。 */
export interface ArchiveTimeReconcileResult {
  archivedAt: Record<string, number>
  changed: boolean
}

/**
 * 将归档时间映射推进到新的宿主归档集合。
 *
 * 只为本次新增的 id 记录时间；启动时已经归档但没有记录的 id 保持未知。
 * 取消归档会移除旧时间，因此再次归档会从新的归档时刻重新计时。
 *
 * @param input - 前后归档集合、已有时间与当前时刻。
 * @returns 新映射及其是否发生变化。
 */
export function reconcileArchiveTimes(input: ArchiveTimeReconcileInput): ArchiveTimeReconcileResult {
  const previous = new Set(input.previousArchivedIds)
  const next = new Set(input.nextArchivedIds)
  const archivedAt: Record<string, number> = {}

  for (const id of input.nextArchivedIds) {
    const existing = input.archivedAt[id]
    if (typeof existing === 'number' && Number.isFinite(existing)) {
      archivedAt[id] = existing
    } else if (!previous.has(id)) {
      archivedAt[id] = input.now
    }
  }

  const previousEntries = Object.entries(input.archivedAt)
    .filter(([id, value]) => next.has(id) && Number.isFinite(value))
  const nextEntries = Object.entries(archivedAt)
  const changed = previousEntries.length !== nextEntries.length
    || nextEntries.some(([id, value]) => input.archivedAt[id] !== value)
    || Object.keys(input.archivedAt).some(id => !next.has(id))
  return { archivedAt, changed }
}

/**
 * 按归档时长筛选批量清理候选；未知归档时间不会进入结果。
 *
 * @param archivedSessionIds - 宿主当前归档顺序。
 * @param archivedAt - 已知归档时间。
 * @param days - 最小归档天数。
 * @param now - 当前 Unix epoch 毫秒。
 * @returns 保持宿主归档顺序的候选 id。
 */
export function eligibleArchivedSessionIds(
  archivedSessionIds: readonly string[],
  archivedAt: ArchivedAtMap,
  days: number,
  now: number,
): string[] {
  const cutoff = now - days * DAY_MS
  return archivedSessionIds.filter((id) => {
    const timestamp = archivedAt[id]
    return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp <= cutoff
  })
}

/** 单条批量清理失败。 */
export interface CleanupFailure {
  sessionId: string
  error: string
}

/** 批量清理结果。 */
export interface CleanupResult {
  deletedSessionIds: string[]
  failures: CleanupFailure[]
}

/**
 * 顺序删除候选并隔离单条失败。
 *
 * @param sessionIds - 待删除会话 id。
 * @param deleteOne - 单条永久删除操作。
 * @returns 成功 id 与失败明细。
 */
export async function cleanupArchivedSessions(
  sessionIds: readonly string[],
  deleteOne: (sessionId: string) => Promise<unknown>,
): Promise<CleanupResult> {
  const deletedSessionIds: string[] = []
  const failures: CleanupFailure[] = []
  for (const sessionId of sessionIds) {
    try {
      await deleteOne(sessionId)
      deletedSessionIds.push(sessionId)
    } catch (error) {
      failures.push({
        sessionId,
        error: String(error instanceof Error ? error.message : error),
      })
    }
  }
  return { deletedSessionIds, failures }
}

/** 归档时间跟踪器构造参数。 */
export interface ArchiveTimeTrackerOptions {
  initialArchivedIds: readonly string[]
  store: ArchiveTimeStore
  now?: () => number
}

/**
 * 串行持久化宿主归档集合变化，并提供一致的时间快照。
 *
 * 任意持久化错误会使队列保持拒绝状态，所有读取与后续写入都失败关闭。
 */
export class ArchiveTimeTracker {
  private archivedIds: string[]
  private archivedAt: Record<string, number> = {}
  private tail: Promise<void>
  private readonly now: () => number

  /** @param options - 初始宿主归档集合、持久化后端与时钟。 */
  constructor(private readonly options: ArchiveTimeTrackerOptions) {
    this.archivedIds = [...options.initialArchivedIds]
    this.now = options.now ?? Date.now
    this.tail = this.initialize()
  }

  /**
   * 记录宿主提交后的完整归档集合。
   * @param archivedSessionIds - 最新归档 id 顺序。
   * @returns 本次持久化完成。
   */
  observe(archivedSessionIds: readonly string[]): Promise<void> {
    const nextIds = [...archivedSessionIds]
    this.tail = this.tail.then(async () => {
      const result = reconcileArchiveTimes({
        previousArchivedIds: this.archivedIds,
        nextArchivedIds: nextIds,
        archivedAt: this.archivedAt,
        now: this.now(),
      })
      if (result.changed) await this.options.store.write(result.archivedAt)
      this.archivedIds = nextIds
      this.archivedAt = result.archivedAt
    })
    return this.tail
  }

  /** @returns 完成所有排队事件后的归档时间副本。 */
  async snapshot(): Promise<Record<string, number>> {
    await this.tail
    return { ...this.archivedAt }
  }

  private async initialize(): Promise<void> {
    const loaded = await this.options.store.read()
    const result = reconcileArchiveTimes({
      previousArchivedIds: this.archivedIds,
      nextArchivedIds: this.archivedIds,
      archivedAt: loaded,
      now: 0,
    })
    if (result.changed) await this.options.store.write(result.archivedAt)
    this.archivedAt = result.archivedAt
  }
}

/** 版本 1 归档时间文件后端。 */
export class ArchiveTimeFileStore implements ArchiveTimeStore {
  /** @param path - 状态 JSON 的绝对路径。 */
  constructor(readonly path: string) {}

  /** @returns 已验证的归档时间映射；文件不存在时为空映射。 */
  async read(): Promise<Record<string, number>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`archive time state is not valid JSON: ${String(error)}`)
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('archive time state must be an object with version 1 and archivedAt')
    }
    const record = raw as Record<string, unknown>
    if (record['version'] !== 1) throw new Error('archive time state must use version 1')
    if (Object.keys(record).some(key => key !== 'version' && key !== 'archivedAt')) {
      throw new Error('archive time state contains unknown fields')
    }
    const values = record['archivedAt']
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('archive time state archivedAt must be an object')
    }
    const archivedAt: Record<string, number> = {}
    for (const [id, value] of Object.entries(values)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`archive time state has invalid timestamp for ${JSON.stringify(id)}`)
      }
      archivedAt[id] = value
    }
    return archivedAt
  }

  /** @param archivedAt - 要原子替换的完整映射。 */
  async write(archivedAt: ArchivedAtMap): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    const text = `${JSON.stringify({ version: 1, archivedAt }, null, 2)}\n`
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
