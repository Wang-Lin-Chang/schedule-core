# schedule-core

> **Part of the [DSH plugin suite](https://github.com/Wang-Lin-Chang)** — six Apache-2.0 plugins for DeepSeek Harness. · DSH 插件套件之一：六个 Apache-2.0 插件。

> A persistent, cross-restart scheduler core: **SQLite as the archive, lease-claim as the coordination, wall-clock discipline as the law**. Zero framework dependencies — execution side effects are host-injected. Every claim carries an experiment number and a control group.
>
> 持久调度核心：**SQLite 档案馆 + 租约认领协调 + 墙钟纪律**。零框架依赖——执行副作用由宿主注入。每个能力声明都带实验编号与对照组。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

## 为什么存在 / Why this exists

进程内提醒器（`setTimeout`）和会话内调度有两个致命问题：**进程一死调度就死**（无持久化），**会话一死提醒就丢**（无跨会话认领）。本核心把调度状态存进 SQLite 档案馆，用单条条件 UPDATE 实现多进程租约抢占——不依赖 Redis、不依赖消息队列，SQLite 就是仲裁者。

| 能力 | 机制 | 实验 |
|---|---|---|
| 跨重启存活 | SQLite 三表 + append-only 事件日志 | 单元/真机闭环 |
| 多消费者互斥 | 租约认领（`claimed_by/lease_until` 单条条件 UPDATE，changes=1 即胜）| EXP-3 I5 |
| 到期派发 | C 混合驱动（最近到期单 timer + 兜底轮询）| EXP-2 |
| 时钟纪律 | RFC3339 严格校验 / IANA 时区 / DST 回转换检测 / 回拨不提前 / 前跳直接 overdue | EXP-5 |
| 冷启动 | 租约释放快路径 + 翻转统一归 sweep | EXP-1 |
| 验证 | 时钟乱序 fuzz + 实装×模型差分 | EXP-3 / EXP-4 |

## 状态模型 / State model

```
scheduled ──(now >= scheduledAt)──▶ overdue ──(认领+派发成功)──▶ dispatched
    │                                  │
    └──(cancel)──▶ cancelled ◀──(cancel)┘
```

- `dispatched` / `cancelled` 为终态。
- 崩溃窗口：派发成功但事件未落盘 → 租约过期（默认 60s）后重认领 → **at-least-once**（不承诺 exactly-once，官方同款诚实声明）。
- `every` 记录只追最新一次（不枚举错过的间隔），锚点对齐推进。

## 快速开始 / Quick start

```ts
import { ScheduleRegistry } from 'schedule-core'

const reg = new ScheduleRegistry({
  dbPath: './data/schedules.db',
  now: Date.now,                          // 可注入时钟（测试/差分验证的关键设计）
  executor: {
    executeJob: (rec) => { /* 宿主执行任务 */ return 'done' },
    deliverReminder: (rec) => { /* 宿主投递提醒 */ return 'done' },
  },
})

const rec = reg.create({ prompt: 'backup', rule: 'after', afterSeconds: 60, action: 'job',
  jobSpec: { kind: 'pwsh', command: 'Backup.ps1', label: 'nightly' } })
reg.list()          // 活动记录
reg.delete(rec.id)  // { deleted: true }
reg.dispose()
```

执行器返回 `'retry'` 时记录保持 `overdue`，下个周期重试——宿主不 ready 时天然退避。

## 诚实边界 / Honest boundaries

- **at-least-once**：崩溃窗口可能重复派发（设计声明，非缺陷）。
- **every 只追最新**：错过的间隔不补跑。
- **无 Cron/日历规则**：`every_seconds ≥ 300`（对齐官方下限）。
- 单机调度：跨机器调度需要共享存储 + 分布式锁——本核心不做，也不声称。
- **离线适用面**：架构上无网络依赖（本地 SQLite + 本地 timer）；数天级断网长跑未实测，不声称。
- 执行动作（job/remind 的副作用）是宿主的事；本核心只保证**何时、由谁、恰好一次认领**。

## 开发 / Development

```sh
npm run build   # tsc → lib/
npm test        # 单元 37 + fuzz 200 种子 + 差分 644 断言
```

要求：Node ≥ 22.6（`node:sqlite`，实测 25.8）。

## License

Apache-2.0
