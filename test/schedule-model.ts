// test/schedule-model.ts —— 调度状态机纯模型（fuzz 与差分验证共享）
export interface S {
  id: string
  status: 'scheduled' | 'overdue' | 'dispatched' | 'cancelled'
  scheduledAt: number
  every?: number
  claimedBy?: string
  leaseUntil?: number
  dispatchCount: number
  overdueAt?: number       // 最近一次进入 overdue 的墙钟（I2 判定用）
  occurrenceAt?: number
}

export class ScheduleModel {
  map = new Map<string, S>()
  now = 0
  events: string[] = []
  private seq = 0
  private leaseMs = 60

  /** arg 统一为"scheduledAt 锚点时刻"；every 的间隔用 everySeconds 独立传入（与实装语义一致） */
  create(rule: 'after' | 'at' | 'every', scheduledAt: number, everySeconds?: number): string {
    const id = `sch-${++this.seq}`
    this.map.set(id, {
      id, status: 'scheduled', scheduledAt,
      every: rule === 'every' ? everySeconds : undefined,
      dispatchCount: 0,
    })
    this.events.push(`create ${id} at ${this.now}`)
    return id
  }
  tick(ms: number) {
    if (ms <= 0) return
    this.now += ms
    for (const s of this.map.values()) {
      if (s.status === 'scheduled' && s.scheduledAt <= this.now) {
        s.status = 'overdue'
        s.overdueAt = this.now
      }
    }
  }
  rollback(ms: number) {
    if (ms <= 0) return
    this.now -= ms   // 回拨不重判 scheduled（已 overdue 不回退，纪律：回拨不撤销判定）
  }
  claim(id: string, who: string): boolean {
    const s = this.map.get(id)
    if (!s) return false
    if (s.status !== 'overdue') return false
    if (s.claimedBy !== undefined && s.leaseUntil !== undefined && s.leaseUntil >= this.now) return false
    s.claimedBy = who
    s.leaseUntil = this.now + this.leaseMs
    return true
  }
  /** 派发成功（幂等）；every 记录推进锚点回到 scheduled（清租约与 overdueAt——fuzz I2/I4 教训） */
  dispatch(id: string, who: string): boolean {
    const s = this.map.get(id)
    if (!s) return false
    if (s.claimedBy !== who) return false
    if (s.status !== 'overdue') return false
    s.dispatchCount++
    s.occurrenceAt = s.scheduledAt
    if (s.every !== undefined) {
      let next = s.scheduledAt + s.every
      while (next <= this.now) next += s.every
      s.scheduledAt = next
      s.status = 'scheduled'
      s.claimedBy = undefined
      s.leaseUntil = undefined
      s.overdueAt = undefined
      this.events.push(`dispatch ${id} occ=${s.occurrenceAt} next=${next}`)
      return true
    }
    s.status = 'dispatched'
    s.claimedBy = undefined
    s.leaseUntil = undefined
    this.events.push(`dispatch ${id}`)
    return true
  }
  crash(id: string) {
    const s = this.map.get(id)
    if (!s) return
    s.claimedBy = undefined   // 持有者没了，租约时间戳还在（到期后可重认领）
  }
  cancel(id: string): boolean {
    const s = this.map.get(id)
    if (!s || s.status === 'dispatched' || s.status === 'cancelled') return false
    s.status = 'cancelled'
    this.events.push(`cancel ${id}`)
    return true
  }
  /** 差分验证用：直接设置墙钟并做 overdue 判定（对应实装的 sweep 前判定） */
  setNowAndMark(t: number) {
    this.now = t
    for (const s of this.map.values()) {
      if (s.status === 'scheduled' && s.scheduledAt <= this.now) {
        s.status = 'overdue'
        s.overdueAt = this.now
      }
    }
  }
  /** 差分验证用：自动派发所有 overdue（对应实装 dispatcher 的 sweep 认领派发） */
  sweepAuto() {
    for (const s of [...this.map.values()]) {
      if (s.status !== 'overdue') continue
      if (!this.claim(s.id, 'auto')) continue
      this.dispatch(s.id, 'auto')
    }
  }

  checkInvariants(): string[] {
    const bad: string[] = []
    for (const s of this.map.values()) {
      if (!['scheduled', 'overdue', 'dispatched', 'cancelled'].includes(s.status)) bad.push(`I1 bad status ${s.id}:${s.status}`)
      if (s.overdueAt !== undefined && s.overdueAt < s.scheduledAt) bad.push(`I2 early overdue ${s.id}`)
      if (s.status === 'dispatched' && s.every === undefined && s.claimedBy !== undefined) bad.push(`I4 dispatched still claimed ${s.id}`)
    }
    return bad
  }

  drainAndCheck(): string[] {
    const bad: string[] = []
    this.tick(100000)
    for (const s of this.map.values()) {
      if (s.status === 'scheduled' && s.scheduledAt <= this.now) bad.push(`I3 stranded ${s.id}`)
      if (s.status === 'overdue') {
        const ok = this.claim(s.id, 'reaper') && this.dispatch(s.id, 'reaper')
        if (!ok && s.every === undefined) bad.push(`I3 undispatchable ${s.id}`)
      }
    }
    return bad
  }
}
