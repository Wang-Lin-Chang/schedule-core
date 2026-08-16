// test/schedule-fuzz.ts —— 调度档案馆·时钟乱序状态机 fuzz（设计验证）
// 纯模型（假时钟），验证设计的不变量后，才允许实装。模型定义见 schedule-model.ts
import { ScheduleModel } from './schedule-model.ts'

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

let passed = 0, failed = 0
let ops = 0
function check(cond: boolean, detail = '') { if (cond) passed++; else { failed++; console.log(`  ❌ ${detail}`) } }

const SEEDS = 200
for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = mulberry32(seed)
  const m = new ScheduleModel()
  const ids: string[] = []
  const steps = 20 + Math.floor(rng() * 40)
  for (let k = 0; k < steps; k++) {
    ops++
    const roll = rng()
    if (roll < 0.2) {
      const rule = ['after', 'at', 'every'][Math.floor(rng() * 3)] as any
      if (rule === 'every') {
        const every = 300 + Math.floor(rng() * 5000)
        ids.push(m.create('every', m.now + every * 1000, every))
      } else {
        ids.push(m.create(rule, m.now + 10 + Math.floor(rng() * 5000)))
      }
    } else if (roll < 0.5) {
      m.tick(1 + Math.floor(rng() * 3000))
    } else if (roll < 0.58) {
      m.rollback(1 + Math.floor(rng() * 2000))
    } else if (roll < 0.85) {
      const id = ids[Math.floor(rng() * ids.length)]
      if (id) {
        const who = rng() < 0.7 ? 'd1' : 'd2'
        if (m.claim(id, who)) m.dispatch(id, who)
        else if (rng() < 0.3) { m.tick(100); if (m.claim(id, who)) m.dispatch(id, who) }
      }
    } else if (roll < 0.92) {
      const id = ids[Math.floor(rng() * ids.length)]
      if (id) m.crash(id)
    } else {
      const id = ids[Math.floor(rng() * ids.length)]
      if (id) m.cancel(id)
    }
    const bad = m.checkInvariants()
    for (const b of bad) check(false, `seed${seed} ${b}`)
  }
  const drainBad = m.drainAndCheck()
  for (const b of drainBad) check(false, `seed${seed} ${b}`)
  if (drainBad.length === 0) passed++
}

console.log('='.repeat(66))
console.log(`  调度时钟乱序 fuzz：${SEEDS} 种子 / ${ops} 次随机操作`)
console.log(`  不变量断言：${passed} 通过 / ${failed} 违反`)
console.log('='.repeat(66))
process.exit(failed > 0 ? 1 : 0)
