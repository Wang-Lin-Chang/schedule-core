// schedule-core/test/schedule-unit.test.ts —— 核心单元验收（状态机/租约/every 回环/事件日志/跨重启/invariant/时钟工具）
// 假时钟 + 注入 executor：纯逻辑确定性验证（真 timer/job spawn 属宿主层，见 dsh-schedule）
import { ScheduleRegistry } from '../src/ScheduleRegistry.ts'
import { validateSchedule } from '../src/schedule-invariant.ts'
import { zonedToEpoch, parseAbsolute } from '../src/time.ts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) passed++
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-core-'))
let clock = 1_800_000_000_000
const dbPath = path.join(dir, 's.db')
const executedJobs: string[] = []
const delivered: string[] = []
const sch = new ScheduleRegistry({
  dbPath,
  leaseMs: 500,
  fallbackPollMs: 3_600_000,
  now: () => clock,
  executor: {
    executeJob: (rec) => { executedJobs.push(rec.id); return 'done' },
    deliverReminder: (rec) => { delivered.push(rec.id); return rec.createdBy === 'live' ? 'done' : 'retry' },
  },
})

// ---- CRUD 校验 ----
const r1 = sch.create({ prompt: 'one-shot', rule: 'after', afterSeconds: 10, action: 'remind', createdBy: 'live' })
check('create 成功且 scheduled', r1.status === 'scheduled' && r1.id === 'sch-1', r1.id)
const r2 = sch.create({ prompt: 'every', rule: 'every', everySeconds: 300, action: 'remind', createdBy: 'live' })
check('every 记录创建', r2.everySeconds === 300)
let badPrompt = false
try { sch.create({ prompt: '  ', rule: 'after', afterSeconds: 10, action: 'remind' }) } catch (e: any) { badPrompt = /invalid_prompt/.test(e.message) }
check('空 prompt 拒绝', badPrompt)
let badFreq = false
try { sch.create({ prompt: 'x', rule: 'every', everySeconds: 60, action: 'remind' }) } catch (e: any) { badFreq = /frequency_too_high/.test(e.message) }
check('高频 every 拒绝（对齐官方 300s）', badFreq)
let badFuture = false
try { sch.create({ prompt: 'x', rule: 'after', afterSeconds: 0, action: 'remind' }) } catch (e: any) { badFuture = /not_future/.test(e.message) }
check('非未来时刻拒绝', badFuture)
let badJob = false
try { sch.create({ prompt: 'x', rule: 'after', afterSeconds: 10, action: 'job' }) } catch (e: any) { badJob = /requires job_spec/.test(e.message) }
check('job 缺 spec 拒绝', badJob)

// ---- 到期派发（假时钟前进 + 手动 sweep）----
clock += 30_000
;(sch as any).sweep()
const after = sch.get(r1.id)!
check('到期自动派发 dispatched', after.status === 'dispatched' && after.dispatchCount === 1, JSON.stringify({ status: after.status, n: after.dispatchCount }))
check('派发清租约（fuzz I4 教训）', after.claimedBy === undefined && after.leaseUntil === undefined)
check('executor 收到 remind', delivered.includes(r1.id) && executedJobs.length === 0, delivered.join(','))

// ---- every 未到期仍 scheduled ----
const everyNow = sch.get(r2.id)!
check('every 未到期仍 scheduled', everyNow.status === 'scheduled')

// ---- every 到期 + 回环 ----
;(sch as any).db.prepare('UPDATE schedules SET scheduled_at=? WHERE id=?').run(clock - 1, r2.id)
;(sch as any).sweep()
const everyAfter = sch.get(r2.id)!
check('every 到期派发后回环 scheduled', everyAfter.status === 'scheduled' && everyAfter.dispatchCount === 1, JSON.stringify(everyAfter))
check('every 锚点推进到未来', everyAfter.scheduledAt > clock, String(everyAfter.scheduledAt))
check('every 回环清 overdueAt 残留（I2 教训）', everyAfter.occurrenceAt !== undefined && everyAfter.occurrenceAt < everyAfter.scheduledAt)

// ---- 租约互斥 ----
const r3 = sch.create({ prompt: 'lease', rule: 'after', afterSeconds: 5, action: 'remind', createdBy: 'live' })
;(sch as any).db.prepare("UPDATE schedules SET status='overdue', scheduled_at=? WHERE id=?").run(clock - 1000, r3.id)
check('claim 成功', sch.claim(r3.id, clock, 'd1'))
check('租约内他人 claim 失败', !sch.claim(r3.id, clock, 'd2'))
check('租约过期后可再 claim', sch.claim(r3.id, clock + 600, 'd2'))
check('非持有者 dispatch 拒绝', sch.dispatch(r3.id, 'd1') === 'not-held')
check('持有者 dispatch 成功', sch.dispatch(r3.id, 'd2') === 'dispatched')
check('派发后不可再 claim', !sch.claim(r3.id, clock, 'd3'))

// ---- job action 走注入 executor ----
const jr = sch.create({ prompt: 'run backup', rule: 'after', afterSeconds: 10, action: 'job', jobSpec: { kind: 'pwsh', command: 'echo hi', label: 'backup' } })
;(sch as any).db.prepare("UPDATE schedules SET status='overdue', scheduled_at=? WHERE id=?").run(clock - 1000, jr.id)
check('job action 命中 executor', sch.executeAction({ ...sch.get(jr.id)! }) === 'done' && executedJobs.includes(jr.id), executedJobs.join(','))

// ---- remind retry 语义（executor 裁决，core 透传）----
const ghost = sch.create({ prompt: 'ghost', rule: 'after', afterSeconds: 10, action: 'remind', createdBy: 'ghost-session' })
;(sch as any).db.prepare("UPDATE schedules SET status='overdue', scheduled_at=? WHERE id=?").run(clock - 1000, ghost.id)
check('executor retry 透传（保持 overdue）', sch.executeAction({ ...sch.get(ghost.id)! }) === 'retry')

// ---- 事件日志 ----
const events = (sch as any).db.prepare('SELECT change FROM schedule_events WHERE schedule_id=? ORDER BY seq').all(r1.id) as any[]
check('事件日志 create+dispatch', events.map((e: any) => e.change).join(',') === 'create,dispatch', JSON.stringify(events))

// ---- 跨重启恢复（僵尸租约释放 + 记录留存）----
{
  // 造一个僵尸租约：另一实例 claim 后"死掉"（不释放）
  const schA = new ScheduleRegistry({ dbPath, leaseMs: 500, fallbackPollMs: 3_600_000, now: () => clock })
  const z = schA.create({ prompt: 'zombie', rule: 'after', afterSeconds: 5, action: 'remind', createdBy: 'live' })
  ;(schA as any).db.prepare("UPDATE schedules SET status='overdue', scheduled_at=? WHERE id=?").run(clock - 1000, z.id)
  schA.claim(z.id, clock, 'dead-dispatcher')
  schA.dispose()
  const schB = new ScheduleRegistry({ dbPath, leaseMs: 500, fallbackPollMs: 3_600_000, now: () => clock })
  const zRec = schB.get(z.id)!
  check('跨重启僵尸租约已释放', zRec.status === 'overdue' && zRec.claimedBy === undefined, JSON.stringify({ st: zRec.status, cb: zRec.claimedBy }))
  check('跨重启记录留存', schB.get(r1.id)!.status === 'dispatched' && schB.get(r2.id)!.status === 'scheduled')
  const events2 = (schB as any).db.prepare('SELECT COUNT(*) AS n FROM schedule_events').get() as any
  check('事件日志跨重启完整', events2.n >= 5, String(events2.n))
  schB.dispose()
}

// ---- invariant ----
{
  const good = sch.create({ prompt: 'ok', rule: 'after', afterSeconds: 10, action: 'remind' })
  const goodFails: string[] = []
  validateSchedule(good, (m) => goodFails.push(m))
  check('invariant 合法记录 0 违规', goodFails.length === 0, goodFails.join('|'))
  const badFails: string[] = []
  validateSchedule({ ...good, id: 'x-1' }, (m) => badFails.push(m))
  check('invariant 坏 id 命中', badFails.some(f => /must be sch-/.test(f)))
  validateSchedule({ ...good, dispatchCount: -1 }, (m) => badFails.push(m))
  check('invariant 负 dispatchCount 命中', badFails.some(f => /non-negative/.test(f)))
  validateSchedule({ ...good, status: 'dispatched', dispatchedAt: undefined, claimedBy: 'd1' }, (m) => badFails.push(m))
  check('invariant 终态残留租约命中', badFails.some(f => /retain a lease/.test(f)))
  validateSchedule({ ...good, rule: 'every', everySeconds: 100 }, (m) => badFails.push(m))
  check('invariant 高频 every 命中', badFails.some(f => /every rule requires/.test(f)))
  validateSchedule({ ...good, action: 'job' }, (m) => badFails.push(m))
  check('invariant job 缺 spec 命中', badFails.some(f => /requires jobSpec/.test(f)))
}

// ---- 时钟工具（EXP-5：DST 回转换检测）----
{
  check('RFC3339 带偏移解析', Number.isFinite(parseAbsolute('2026-08-16T10:00:00Z')) && parseAbsolute('2026-08-16T10:00:00Z') === Date.parse('2026-08-16T10:00:00Z'))
  check('RFC3339 偏移换算', parseAbsolute('2026-08-16T10:00:00+08:00') === Date.parse('2026-08-16T02:00:00Z'))
  let badTz = false
  try { parseAbsolute('2026-08-16T10:00:00', 'Not/AZone') } catch (e: any) { badTz = /RangeError|invalid/.test(String(e)) }
  check('无效 IANA 时区拒绝', badTz)
  let noTz = false
  try { parseAbsolute('2026-08-16T10:00:00') } catch (e: any) { noTz = /invalid_time_zone/.test(e.message) }
  check('local 形式缺时区拒绝', noTz)
  // DST 缺口（美东 2026-03-08 02:30 不存在）：回转换不还原 → 拒绝
  let dstGap = false
  try { zonedToEpoch('2026-03-08T02:30:00', 'America/New_York') } catch (e: any) { dstGap = /DST gap/.test(e.message) }
  check('DST 缺口拒绝', dstGap)
  // 正常时刻往返一致
  const normal = zonedToEpoch('2026-07-16T10:00:00', 'America/New_York')
  check('夏令时正常转换', Number.isFinite(normal) && normal === Date.parse('2026-07-16T14:00:00Z'), String(normal))
}

sch.dispose()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log('='.repeat(66))
console.log(`  调度核心单元验收: ${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(66))
process.exit(failed > 0 ? 1 : 0)
