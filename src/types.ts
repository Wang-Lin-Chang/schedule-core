// schedule-core/src/types.ts —— 核心接口（零框架依赖：执行副作用由宿主注入）
export type ScheduleRule = 'after' | 'at' | 'every'
export type ScheduleAction = 'remind' | 'job'
export type ScheduleStatus = 'scheduled' | 'overdue' | 'dispatched' | 'cancelled'

export interface ScheduleInput {
  prompt: string
  rule: ScheduleRule
  afterSeconds?: number
  atEpochMs?: number          // 规范 UTC epoch ms（入参已规范化的时刻）
  everySeconds?: number
  action: ScheduleAction
  jobSpec?: { kind: string; command: string; label: string }
  createdBy?: string
}

export interface ScheduleRecord {
  id: string
  action: ScheduleAction
  rule: ScheduleRule
  prompt: string
  jobSpec?: { kind: string; command: string; label: string }
  scheduledAt: number
  everySeconds?: number
  status: ScheduleStatus
  claimedBy?: string
  leaseUntil?: number
  createdBy?: string
  createdAt: number
  dispatchedAt?: number
  dispatchCount: number
  occurrenceAt?: number
}

/** 调度动作执行器（宿主注入）：返回 done 派发完成；retry 保持 overdue 下周期重试 */
export interface ActionExecutor {
  executeJob(rec: ScheduleRecord): 'done' | 'retry'
  deliverReminder(rec: ScheduleRecord): 'done' | 'retry'
}

export interface ScheduleLogger {
  warn(message: string): void
}

export interface ScheduleConfig {
  dbPath?: string
  leaseMs?: number
  fallbackPollMs?: number
  /** 时钟注入（测试/差分验证用；默认 Date.now） */
  now?: () => number
  /** 调度动作执行器（缺省时 job/remind 均保持 overdue 重试——纯状态机模式） */
  executor?: ActionExecutor
  logger?: ScheduleLogger
}
