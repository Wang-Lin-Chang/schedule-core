// schedule-core/test/schedule-diff.test.ts —— 实装与模型差分验证
// 同一随机操作序列同时打到模型（内存）与真实 SQLite 实装上：
// 操作返回值直接比对 + 逐步状态比对——机制化"实装与参考模型严格一致"。
import { ScheduleModel } from './schedule-model.ts'
import { ScheduleRegistry } from '../src/ScheduleRegistry.ts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed++
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}

const SEEDS = 100
for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = mulberry32(seed)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sdiff-${seed}-`))
  let clock = 0
  const clockFn = () => clock

  const model = new ScheduleModel()
  model.now = clock

  const impl = new ScheduleRegistry({ dbPath: path.join(dir, 's.db'), leaseMs: 60, fallbackPollMs: 3600000, now: clockFn })

  const pairs: { mid: string; iid: string }[] = []

  const steps = 10 + Math.floor(rng() * 30)
  for (let k = 0; k < steps; k++) {
    const roll = rng()
    if (roll < 0.3) {
      // create（秒级精确对齐：afterSeconds 整数秒，arg = clock + N*1000）
      const rule = ['after', 'at', 'every'][Math.floor(rng() * 3)] as 'after' | 'at' | 'every'
      if (rule === 'after') {
        const secs = 2 + Math.floor(rng() * 30)
        const arg = clock + secs * 1000
        const mid = model.create('after', arg)
        const irec = impl.create({ prompt: `p-${mid}`, rule: 'after', afterSeconds: secs, action: 'remind' })
        pairs.push({ mid, iid: irec.id })
      } else if (rule === 'at') {
        const arg = clock + 2000 + Math.floor(rng() * 30000)
        const mid = model.create('at', arg)
        const irec = impl.create({ prompt: `p-${mid}`, rule: 'at', atEpochMs: arg, action: 'remind' })
        pairs.push({ mid, iid: irec.id })
      } else {
        const secs = 300 + Math.floor(rng() * 2000)
        const arg = clock + secs * 1000
        const mid = model.create('every', arg, secs)
        const irec = impl.create({ prompt: `p-${mid}`, rule: 'every', everySeconds: secs, action: 'remind' })
        pairs.push({ mid, iid: irec.id })
      }
    } else if (roll < 0.65) {
      clock += 1 + Math.floor(rng() * 3000)
      model.setNowAndMark(clock)
      ;(impl as any).sweep()
      model.sweepAuto()
    } else if (roll < 0.72) {
      clock = Math.max(0, clock - Math.floor(rng() * 1000))
      model.setNowAndMark(clock)
      ;(impl as any).sweep()
      model.sweepAuto()
    } else if (roll < 0.92) {
      const who = rng() < 0.5 ? 'd1' : 'd2'
      const p = pairs[Math.floor(rng() * pairs.length)]
      if (p !== undefined) {
        const g1 = impl.claim(p.iid, clock, who)
        const g2 = model.claim(p.mid, who)
        check(`seed${seed} claim 返回值一致`, g1 === g2, `impl=${g1} model=${g2} ${p.iid} clock=${clock}`)
        if (g1 && g2) {
          const r1 = impl.dispatch(p.iid, who)
          const r2 = model.dispatch(p.mid, who)
          check(`seed${seed} dispatch 返回值一致`, r1 === 'dispatched' && r2 === true, `impl=${r1} model=${r2}`)
        }
      }
    } else {
      const p = pairs[Math.floor(rng() * pairs.length)]
      if (p !== undefined) {
        const d1 = impl.delete(p.iid)
        const d2 = model.cancel(p.mid)
        check(`seed${seed} delete/cancel 返回值一致`, d1.deleted === d2, `impl=${d1.deleted} model=${d2}`)
      }
    }

    // 逐步状态比对
    for (const p of pairs) {
      const irec = impl.get(p.iid)
      const mrec = model.map.get(p.mid)
      if (irec === undefined || mrec === undefined) continue
      const same = irec.status === mrec.status &&
        irec.dispatchCount === mrec.dispatchCount &&
        irec.scheduledAt === mrec.scheduledAt
      if (!same) {
        check(`seed${seed} 状态一致`, false,
          `impl(${p.iid}): ${irec.status}/${irec.dispatchCount}/${irec.scheduledAt} vs model(${p.mid}): ${mrec.status}/${mrec.dispatchCount}/${mrec.scheduledAt} clock=${clock}`)
      }
    }
  }
  passed++
  impl.dispose()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log('='.repeat(66))
console.log(`  实装×模型差分：${SEEDS} 种子，操作返回值 + 逐步状态比对`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
console.log('='.repeat(66))
process.exit(failed > 0 ? 1 : 0)
