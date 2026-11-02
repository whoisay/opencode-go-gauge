/**
 * OpenCode Go 用量的纯逻辑：额度表、撞墙判断、进度条、倒计时。
 *
 * 抽成纯函数是为了能测。UI 那一层没法自动验证，
 * 但「哪个模型会先被限流」「剩余时间怎么显示」这些是能精确断言的。
 *
 * 这个文件不允许引入运行时依赖。
 */

/** 三个计费窗口。 */
export type Window = "rolling" | "weekly" | "monthly"

/** 一个窗口的美元上限。 */
export type AccountWindows = Record<Window, number>

/**
 * Go 套餐的账户级总额度，单位美元。
 *
 * 来源：实测 `/console/api/go/status` 返回
 * fiveHour limitMicroCents = 1200000000，week = 3000000000，month = 6000000000。
 * Go Plus 和 Teams 的额度不同，所以这个值可以被配置覆盖。
 */
export const GO_ACCOUNT: AccountWindows = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
}

/**
 * Go 套餐下各模型的月额度，单位美元，抄自官方定价页。
 *
 * 注意：这是文档声称的「单模型上限」，但实际实现不生效。
 * 官方 issue #60311（open）和 #54875（closed）都证实：Go 的 5h/周/月额度
 * 是所有付费模型共享的单一池，耗尽任何一个模型会锁住全部模型。
 * 所以这个表只作为定价参考，不能拿来当分母算「单模型还剩多少」。
 */
export const GO_MONTHLY: Record<string, number> = {
  "glm-5.3-flash": 60,
  "glm-5.3": 15,
  "glm-5.2": 60,
  "kimi-k3.1-pro": 15,
  "kimi-k3": 15,
  "kimi-k2.7-code": 60,
  "longcat-2.0": 60,
  "step-5-preview": 15,
  "mimo-v2.6-flash": 60,
  "mimo-v2.6-pro": 15,
  "mimo-v2.5": 60,
  "mimo-v2.5-pro": 15,
  "minimax-m3.1-flash": 20,
  "minimax-m3": 60,
  "muse-spark-1.3-contributor": 60,
  "muse-spark-1.2-contributor": 60,
  "qwen3.8-max": 15,
  "qwen3.8-flash": 30,
  "qwen3.7-plus": 60,
  "deepseek-v4.1-flash": 100,
  "deepseek-v4-pro": 15,
  "hy4-preview": 30,
  hy3: 60,
  "grok-4.7": 15,
  "gpt-6-luna": 15,
  "gpt-5.6-luna": 15,
  "claude-haiku-5-5": 15,
  "gemini-4-argon": 30,
}

/**
 * 单模型的三窗口上限，按文档公式算（5h = 月额度 × 20%，周 50%，月 100%）。
 *
 * 仅作参考：实测这个上限不生效（见 GO_MONTHLY 的注释）。保留函数是因为
 * 文档一旦改回按模型执行，面板可以直接拿来用，但当前 UI 不显示它。
 */
export function modelWindows(monthly: number): AccountWindows {
  return {
    rolling: monthly * 0.2,
    weekly: monthly * 0.5,
    monthly,
  }
}

export type Bottleneck = {
  /** 模型 ID，和 opencode-go/<id> 的后半段一致 */
  id: string
  /** 该模型的月额度（美元） */
  monthly: number
  /** 该模型的三窗口上限 */
  windows: AccountWindows
}

/**
 * 找出会先于账户总额度撞墙的模型。
 *
 * 判断标准：任一窗口的单模型上限小于账户上限。按最紧的月额度升序排，
 * 第一个就是最先被限流的。
 */
export function bottlenecks(
  account: AccountWindows,
  table: Record<string, number> = GO_MONTHLY,
): Bottleneck[] {
  const out: Bottleneck[] = []
  for (const [id, monthly] of Object.entries(table)) {
    const windows = modelWindows(monthly)
    if (
      windows.rolling < account.rolling ||
      windows.weekly < account.weekly ||
      windows.monthly < account.monthly
    ) {
      out.push({ id, monthly, windows })
    }
  }
  return out.sort((a, b) => a.monthly - b.monthly || a.id.localeCompare(b.id))
}

/**
 * ASCII 进度条。
 *
 * 不用 █░ 这类块字符：它们在东亚宽度里是 ambiguous，不同终端算 1 列或 2 列，
 * 窄面板里会把行撑破。ASCII 的宽度是确定的。
 */
export function bar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clamped / 100) * width)
  return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled))
}

export type Level = "ok" | "warn" | "danger"

/** 阈值：75% 起警告，90% 起危险，和官方内置插件的分级一致。 */
export function level(percent: number): Level {
  if (percent >= 90) return "danger"
  if (percent >= 75) return "warn"
  return "ok"
}

/**
 * 距离重置还有多久。
 *
 * 超过一天显示天+小时，超过一小时显示时+分，否则只显示分。
 * 已经到期显示 now。
 */
export function countdown(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (!Number.isFinite(ms) || ms <= 0) return "now"
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** 美元格式化，保留两位。 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * 小额美元格式化。
 *
 * 单笔请求的配额消耗通常在 $0.0001 到 $0.01 之间，两位小数会全变成 $0.00。
 * 小于一美元时保留四位，超过一美元回到两位。
 */
export function formatUsdFine(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * 百分比格式化。
 *
 * 10% 以下统一保留一位小数（2.0%、0.6%、0.3%），10% 以上取整。
 * 这样三行的数字宽度一致，右对齐后不会参差；同时 0.04% 也不会被
 * 四舍五入成 0% 看起来像没生效。
 */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "?"
  if (percent < 10) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

/**
 * 把宿主的 meter 归一化成统一结构。
 *
 * 宿主返回的 resetsAt 是 epoch 毫秒；Go 的 HTTP 接口返回的是 ISO 字符串。
 * 这里只接受毫秒，ISO 的转换放在调用方做，避免两种格式混进来。
 */
export type Meter = {
  percent: number
  limited: boolean
  resetsAt: number
}

export function normalizeMeter(input: {
  percent?: number
  limited?: boolean
  resetsAt?: number
}): Meter {
  return {
    percent: Number.isFinite(input.percent) ? Math.max(0, input.percent ?? 0) : 0,
    limited: input.limited === true,
    resetsAt: Number.isFinite(input.resetsAt) ? (input.resetsAt ?? 0) : 0,
  }
}

/** 三个窗口合起来的整体状态。 */
export type Overall = "ok" | "warn" | "danger" | "limited"

/**
 * 取三个窗口里最紧的那个来定整体状态。
 *
 * 任一窗口被限流就是 limited；否则看最高百分比。这和「哪个窗口先到期」
 * 无关——用户关心的是「现在还能不能继续用」，所以取最坏的那个。
 */
export function overall(meters: Record<Window, Meter>): Overall {
  const values = [meters.rolling, meters.weekly, meters.monthly]
  if (values.some((meter) => meter.limited)) return "limited"
  const highest = Math.max(...values.map((meter) => meter.percent))
  if (highest >= 90) return "danger"
  if (highest >= 75) return "warn"
  return "ok"
}

export function overallLabel(value: Overall): string {
  if (value === "limited") return "已限流"
  if (value === "danger") return "即将限流"
  if (value === "warn") return "接近上限"
  return "正常"
}

/**
 * 进度条填充宽度，单位是百分比。
 *
 * 非零值至少给一格：14 格的条里 0.9% 只有 0.13 格，Yoga 取整后什么都不画，
 * 看起来像没数据。给一格既能看到「有消耗」，又不至于夸张。
 */
export function fillPercent(percent: number, cells: number): number {
  if (!Number.isFinite(percent) || percent <= 0 || cells <= 0) return 0
  return Math.max(100 / cells, Math.min(100, percent))
}


