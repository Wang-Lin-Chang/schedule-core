// schedule-core/src/time.ts —— 时钟纪律工具（EXP-5：DST 回转换检测；官方协议继承）
// RFC3339 严格形式（无偏移字符串拒绝）
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

export function parseAbsolute(at: string, timeZone?: string): number {
  if (RFC3339.test(at)) {
    const ms = Date.parse(at)
    if (!Number.isFinite(ms)) throw new Error('invalid_selector')
    return ms
  }
  if (LOCAL.test(at)) {
    if (typeof timeZone !== 'string' || timeZone.length === 0) throw new Error('invalid_time_zone: local at requires time_zone')
    return zonedToEpoch(at, timeZone)
  }
  throw new Error('invalid_selector')
}

/** IANA 时区 → UTC epoch（Intl 反推偏移 + 回转换检测 DST 缺口/重叠歧义） */
export function zonedToEpoch(local: string, tz: string): number {
  const m = LOCAL.exec(local)
  if (!m) throw new Error('invalid_selector: local form requires YYYY-MM-DDTHH:mm:ss')
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const asUTC = Date.parse(`${local}Z`)
  if (!Number.isFinite(asUTC)) throw new Error('invalid_selector')
  const parts = fmt.formatToParts(new Date(asUTC))
  const get = (t: string) => parts.find(p => p.type === t)?.value
  const want = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const offsetSec = (Date.parse(`${want}Z`) - asUTC) / 1000
  const utcMs = asUTC - offsetSec * 1000
  // 回转换检测：fmt(utcMs) 必须还原为入参 local 本身。
  // 曾误与中间量 want 比较（want 是假锚的墙钟表示，非零偏移下必不等 → 正常时刻被误判 DST 缺口）
  // —— 解耦提取 + 单元测试覆盖正常转换路径时当场抓到。
  const back = fmt.formatToParts(new Date(utcMs))
  const backStr = `${back.find(p => p.type === 'year')?.value}-${back.find(p => p.type === 'month')?.value}-${back.find(p => p.type === 'day')?.value}T${back.find(p => p.type === 'hour')?.value}:${back.find(p => p.type === 'minute')?.value}:${back.find(p => p.type === 'second')?.value}`
  if (backStr !== local) throw new Error('invalid_selector: local time falls in a DST gap or is ambiguous')
  return utcMs
}
