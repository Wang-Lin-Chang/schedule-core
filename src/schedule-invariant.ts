// schedule-core/src/schedule-invariant.ts —— 调度记录自研 invariant（规则采样自官方 dsh-schedule invariant）
// 官方裁判审"会话事件日志"，本核心审 SQLite 记录——协议层不兼容的诚实变通（规则逐条采样，见 SCHEDULE-DESIGN.md）。
import type { ScheduleRecord } from './types.ts'

export const MIN_FOUR_DIGIT_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')
export const MAX_FOUR_DIGIT_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')
export const MIN_EVERY_SECONDS = 300

/** 官方同款：id 必须 <prefix>-<正整数> */
export const SCHEDULE_ID = /^sch-[1-9]\d*$/

/**
 * 校验一条调度记录的跨字段关系（官方 validateSnapshot 同款结构）。
 * 违反时调用 fail(稳定诊断)，不抛异常。
 */
export function validateSchedule(rec: ScheduleRecord, fail: (msg: string) => void): void {
  const id = String(rec.id)
  if (!SCHEDULE_ID.test(id)) fail(`schedule id ${JSON.stringify(id)} must be sch-<positive ordinal>`)
  if (rec.prompt.trim().length === 0) fail(`schedule ${JSON.stringify(id)} prompt must be non-empty`)
  if (!Number.isSafeInteger(rec.scheduledAt)
    || rec.scheduledAt < MIN_FOUR_DIGIT_YEAR_MS
    || rec.scheduledAt > MAX_FOUR_DIGIT_YEAR_MS) {
    fail(`schedule ${JSON.stringify(id)} scheduledAt must be an epoch ms within the four-digit year window`)
  }
  if (!['scheduled', 'overdue', 'dispatched', 'cancelled'].includes(rec.status)) {
    fail(`schedule ${JSON.stringify(id)} invalid status ${JSON.stringify(rec.status)}`)
  }
  // 终态一致性（官方 finishedAt ⇔ terminal 同款）：dispatched 必须有 dispatchedAt
  if (rec.status === 'dispatched' && !Number.isSafeInteger(rec.dispatchedAt)) {
    fail(`schedule ${JSON.stringify(id)} dispatched status requires dispatchedAt`)
  }
  if (rec.status !== 'dispatched' && rec.dispatchedAt !== undefined) {
    fail(`schedule ${JSON.stringify(id)} dispatchedAt present only for dispatched status`)
  }
  if (rec.dispatchedAt !== undefined && rec.dispatchedAt < rec.scheduledAt) {
    fail(`schedule ${JSON.stringify(id)} dispatchedAt must not precede scheduledAt`)
  }
  // every 规则约束（官方 MIN_EVERY_INTERVAL_SECONDS 同款）
  if (rec.rule === 'every' && (rec.everySeconds === undefined || rec.everySeconds < MIN_EVERY_SECONDS)) {
    fail(`schedule ${JSON.stringify(id)} every rule requires every_seconds >= ${MIN_EVERY_SECONDS}`)
  }
  if (rec.rule !== 'every' && rec.everySeconds !== undefined) {
    fail(`schedule ${JSON.stringify(id)} everySeconds only valid for every rule`)
  }
  // 租约一致性（fuzz I4 教训的机制化）：终态不得残留持有者
  if ((rec.status === 'dispatched' || rec.status === 'cancelled') && rec.claimedBy !== undefined) {
    fail(`schedule ${JSON.stringify(id)} terminal status must not retain a lease holder`)
  }
  // job action 约束
  if (rec.action === 'job' && (rec.jobSpec === undefined || rec.jobSpec.command.trim().length === 0)) {
    fail(`schedule ${JSON.stringify(id)} action=job requires jobSpec.command`)
  }
  if (rec.action !== 'job' && rec.action !== 'remind') {
    fail(`schedule ${JSON.stringify(id)} invalid action ${JSON.stringify(rec.action)}`)
  }
  // dispatchCount 单调性约束（≥0 整数）
  if (!Number.isSafeInteger(rec.dispatchCount) || rec.dispatchCount < 0) {
    fail(`schedule ${JSON.stringify(id)} dispatchCount must be a non-negative safe integer`)
  }
}

/** 批量校验：对列表逐条 fail 收集 */
export function validateSchedules(recs: ScheduleRecord[], fail: (msg: string) => void): void {
  for (const rec of recs) validateSchedule(rec, fail)
}
