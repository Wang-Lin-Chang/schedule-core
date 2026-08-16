// schedule-core/src/ScheduleRegistry.ts —— 持久调度核心（零框架依赖：执行副作用宿主注入）
// 状态模型/租约协议/时钟纪律：SCHEDULE-DESIGN.md
// 派发驱动 = EXP-2 判决 C 混合（最近到期单 timer + 兜底轮询）
// 冷启动 = EXP-1 判决：recover 只做租约释放（快路径）；到期翻转统一归 sweep（启动不阻塞，10 万全过期实测 779ms → 0）
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ScheduleAction, ScheduleConfig, ScheduleInput, ScheduleLogger, ScheduleRecord, ScheduleRule, ScheduleStatus } from './types.ts'

export const MIN_EVERY_INTERVAL_SECONDS = 300   // 对齐官方固定下限
const MAX_TIMER_DELAY_MS = 2147483647           // Node timer 上限（官方同款拆分）
const DEFAULT_LEASE_MS = 60_000                 // 租约 60s
const FALLBACK_POLL_MS = 60_000                 // 兜底轮询（时钟回拨保险）

export class ScheduleRegistry {
  static Config = {
    dbPath: '',
    leaseMs: DEFAULT_LEASE_MS,
    fallbackPollMs: FALLBACK_POLL_MS,
  }

  private db: DatabaseSync
  private leaseMs: number
  private fallbackPollMs: number
  private nowFn: () => number
  private executor: ScheduleConfig['executor']
  private logger?: ScheduleLogger
  private who: string                      // dispatcher 身份
  private timer?: NodeJS.Timeout
  private pollTimer?: NodeJS.Timeout
  private stopped = false
  private driving = false

  constructor(config: ScheduleConfig = {}) {
    this.leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS
    this.fallbackPollMs = config.fallbackPollMs ?? FALLBACK_POLL_MS
    this.nowFn = config.now ?? Date.now
    this.executor = config.executor
    this.logger = config.logger
    this.who = `dsp-${Math.random().toString(36).slice(2, 8)}`
    const dbPath = config.dbPath ?? './data/schedules.db'
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('remind','job')),
        rule TEXT NOT NULL CHECK(rule IN ('after','at','every')),
        prompt TEXT NOT NULL,
        job_spec TEXT,
        scheduled_at INTEGER NOT NULL,
        every_seconds INTEGER,
        status TEXT NOT NULL DEFAULT 'scheduled'
          CHECK(status IN ('scheduled','overdue','dispatched','cancelled')),
        claimed_by TEXT,
        lease_until INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        occurrence_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, scheduled_at);
      CREATE TABLE IF NOT EXISTS schedule_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        change TEXT NOT NULL CHECK(change IN ('create','delete','dispatch')),
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_counters (kind TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
    `)
    this.recover()
    this.startDriver()
  }

  // ---------------- 恢复（EXP-1：只做快路径——僵尸租约释放；到期翻转归 sweep 统一路径） ----------------
  private recover(): void {
    // 旧租约（本进程重启前的）全部释放（持有者进程已死）
    this.db.prepare("UPDATE schedules SET claimed_by=NULL, lease_until=NULL WHERE status='overdue'").run()
  }

  // ---------------- 变更事件日志（append-only，学官方） ----------------
  private event(id: string, change: 'create' | 'delete' | 'dispatch', payload: unknown): void {
    this.db.prepare('INSERT INTO schedule_events (schedule_id, change, payload, at) VALUES (?,?,?,?)')
      .run(id, change, JSON.stringify(payload), this.nowFn())
  }

  // ---------------- 创建 ----------------
  create(input: ScheduleInput): ScheduleRecord {
    if (input.prompt.trim().length === 0) throw new Error('invalid_prompt: expected a non-empty prompt')
    const scheduledAt = input.rule === 'after'
      ? this.nowFn() + (input.afterSeconds ?? 0) * 1000
      : input.rule === 'at' ? (input.atEpochMs ?? 0) : this.nowFn() + (input.everySeconds ?? 0) * 1000
    if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= this.nowFn()) throw new Error('not_future: scheduledAt must be a future instant')
    if (input.rule === 'every' && (input.everySeconds === undefined || input.everySeconds < MIN_EVERY_INTERVAL_SECONDS)) {
      throw new Error(`frequency_too_high: every_seconds must be >= ${MIN_EVERY_INTERVAL_SECONDS}`)
    }
    if (input.action === 'job' && (input.jobSpec === undefined || input.jobSpec.command.trim().length === 0)) {
      throw new Error('invalid_rule: action=job requires job_spec.command')
    }
    const id = `sch-${this.nextId()}`
    this.db.prepare(`INSERT INTO schedules (id, action, rule, prompt, job_spec, scheduled_at, every_seconds, status, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.action, input.rule, input.prompt, input.jobSpec ? JSON.stringify(input.jobSpec) : null,
        scheduledAt, input.everySeconds ?? null, 'scheduled', input.createdBy ?? null, this.nowFn())
    this.event(id, 'create', input)
    this.drive()
    return this.get(id)!
  }

  list(): ScheduleRecord[] {
    return this.db.prepare("SELECT * FROM schedules WHERE status IN ('scheduled','overdue') ORDER BY created_at").all().map(r => this.row(r))
  }
  get(id: string): ScheduleRecord | undefined {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as any
    return r === undefined ? undefined : this.row(r)
  }
  delete(id: string): { id: string; deleted: boolean; code?: string } {
    if (id.trim().length === 0) throw new Error('invalid id')
    const r = this.get(id)
    if (r === undefined || r.status === 'dispatched' || r.status === 'cancelled') return { id, deleted: false, code: 'schedule_not_found' }
    this.db.prepare("UPDATE schedules SET status='cancelled' WHERE id=?").run(id)
    this.event(id, 'delete', { id })
    this.drive()
    return { id, deleted: true }
  }

  private nextId(): number {
    const row = this.db.prepare(`INSERT INTO schedule_counters (kind,count) VALUES ('sch',1) ON CONFLICT(kind) DO UPDATE SET count=count+1 RETURNING count`).get() as { count: number }
    return row.count
  }

  private row(r: any): ScheduleRecord {
    return {
      id: r.id, action: r.action, rule: r.rule, prompt: r.prompt,
      jobSpec: r.job_spec === null ? undefined : JSON.parse(r.job_spec),
      scheduledAt: r.scheduled_at, everySeconds: r.every_seconds ?? undefined,
      status: r.status, claimedBy: r.claimed_by ?? undefined, leaseUntil: r.lease_until ?? undefined,
      createdBy: r.created_by ?? undefined, createdAt: r.created_at,
      dispatchedAt: r.dispatched_at ?? undefined, dispatchCount: r.dispatch_count,
      occurrenceAt: r.occurrence_at ?? undefined,
    }
  }

  // ---------------- 租约认领（原子抢占：单条条件 UPDATE，changes=1 即胜） ----------------
  claim(id: string, now: number, who: string = this.who, leaseMs: number = this.leaseMs): boolean {
    const res = this.db.prepare(`UPDATE schedules SET claimed_by=?, lease_until=?
      WHERE id=? AND status='overdue' AND (claimed_by IS NULL OR lease_until < ?)`)
      .run(who, now + leaseMs, id, now)
    return res.changes === 1
  }

  // ---------------- 派发（dispatch 事务清租约——fuzz I4 教训） ----------------
  dispatch(id: string, who: string = this.who): 'dispatched' | 'not-held' | 'not-overdue' {
    const now = this.nowFn()
    const rec = this.get(id)
    if (rec === undefined) return 'not-overdue'
    if (rec.status !== 'overdue') return 'not-overdue'
    if (rec.claimedBy !== who) return 'not-held'
    if (rec.everySeconds !== undefined) {
      let next = rec.scheduledAt + rec.everySeconds * 1000
      while (next <= now) next += rec.everySeconds * 1000
      this.db.prepare(`UPDATE schedules SET scheduled_at=?, status='scheduled', claimed_by=NULL, lease_until=NULL,
        dispatch_count=dispatch_count+1, occurrence_at=?, dispatched_at=? WHERE id=?`)
        .run(next, rec.scheduledAt, now, id)
    } else {
      this.db.prepare(`UPDATE schedules SET status='dispatched', claimed_by=NULL, lease_until=NULL,
        dispatch_count=dispatch_count+1, occurrence_at=?, dispatched_at=? WHERE id=?`)
        .run(rec.scheduledAt, now, id)
    }
    this.event(id, 'dispatch', { occurrenceAt: rec.scheduledAt, at: now })
    return 'dispatched'
  }

  /** 执行 action（宿主注入的 executor；缺省 → retry 保持 overdue） */
  executeAction(rec: ScheduleRecord): 'done' | 'retry' {
    if (this.executor === undefined) return 'retry'
    try {
      if (rec.action === 'job') return this.executor.executeJob(rec)
      return this.executor.deliverReminder(rec)
    } catch (error) {
      this.logger?.warn(`schedule: action failed for ${rec.id}: ${String(error)}`)
      return 'retry'
    }
  }

  // ---------------- 派发驱动（EXP-2 判决 C 混合） ----------------
  private startDriver(): void {
    // 兜底轮询（时钟回拨/timer 失效保险）
    this.pollTimer = setInterval(() => { try { this.sweep() } catch {} }, this.fallbackPollMs)
    this.scheduleNextTimer()
  }

  /** 最近到期单 timer：到期 → sweep → 重排 */
  private scheduleNextTimer(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const row = this.db.prepare("SELECT scheduled_at FROM schedules WHERE status='scheduled' ORDER BY scheduled_at LIMIT 1").get() as any
    if (row === undefined) return
    let delay = row.scheduled_at - this.nowFn()
    if (delay <= 0) { this.sweep(); return }
    if (delay > MAX_TIMER_DELAY_MS) delay = MAX_TIMER_DELAY_MS   // 拆 Node timer 上限（官方同款）
    this.timer = setTimeout(() => { this.sweep() }, delay)
  }

  /** 唤醒后重读墙钟（时钟回拨不提前触发），推进 overdue → 认领 → 派发 → 重排 */
  private sweep(): void {
    if (this.driving || this.stopped) return
    this.driving = true
    try {
      const now = this.nowFn()
      this.db.prepare("UPDATE schedules SET status='overdue' WHERE status='scheduled' AND scheduled_at <= ?").run(now)
      const due = this.db.prepare("SELECT * FROM schedules WHERE status='overdue' ORDER BY scheduled_at").all() as any[]
      for (const r of due) {
        const rec = this.row(r)
        if (!this.claim(rec.id, now)) continue          // 别人持有或租约有效
        const res = this.dispatch(rec.id)
        if (res !== 'dispatched') continue
        const fresh = this.get(rec.id)!
        if (fresh.status === 'dispatched' || fresh.status === 'scheduled') {
          const act = this.executeAction({ ...fresh })
          void act
        }
      }
    } finally {
      this.driving = false
      this.scheduleNextTimer()
    }
  }

  /** 外部触发重排（create/delete 后） */
  drive(): void { this.scheduleNextTimer() }

  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    try { this.db.close() } catch {}
  }
}
