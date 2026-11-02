/**
 * 逐请求配额账本。
 *
 * Go 的官方查询接口只给账户级百分比，拿不到「哪个模型用了多少」。
 * 唯一精确的来源是每个响应里的 `usage.opencode.allowance`——它表示
 * 「这一笔计入了多少美元配额」。
 *
 * 所以这里做两件事：
 * 1. server 端 hook 把每笔 allowance 追加成 JSONL
 * 2. TUI 端按窗口过滤求和，得到当前模型的真实消耗
 *
 * 已知局限：装插件之前的历史补不回来，账本从第一次请求开始算。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Entry = {
  /** 请求完成时间，epoch 毫秒 */
  at: number
  /** 模型 ID，不带 provider 前缀 */
  model: string
  /** 这一笔计入的美元配额 */
  allowance: number
  /** primary / title / compaction / generate */
  kind: string
}

export const LEDGER_PATH = join(homedir(), ".local", "share", "opencode", "go-usage", "ledger.jsonl")

/** 只保留最近这么多天，防止文件无限增长。 */
const KEEP_DAYS = 31
/** 超过这么多行才触发一次压缩，避免每条都重写整个文件。 */
const COMPACT_THRESHOLD = 4000

export function parseLine(line: string): Entry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed)
    if (
      typeof value?.at === "number" &&
      typeof value?.model === "string" &&
      typeof value?.allowance === "number" &&
      Number.isFinite(value.allowance) &&
      value.allowance > 0
    ) {
      return {
        at: value.at,
        model: value.model,
        allowance: value.allowance,
        kind: typeof value.kind === "string" ? value.kind : "primary",
      }
    }
  } catch {
    /* 坏行直接跳过，不影响其他记录 */
  }
  return null
}

export function parseLedger(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split("\n")) {
    const entry = parseLine(line)
    if (entry) out.push(entry)
  }
  return out
}

/** 读账本。文件不存在返回空数组，不抛错。 */
export function readLedger(path = LEDGER_PATH): Entry[] {
  try {
    if (!existsSync(path)) return []
    return parseLedger(readFileSync(path, "utf8"))
  } catch {
    return []
  }
}

/**
 * 追加一条记录，必要时压缩。
 *
 * 压缩逻辑：读全文，只留最近 KEEP_DAYS 天，重写。压缩失败不影响本次追加。
 */
export function appendEntry(entry: Entry, path = LEDGER_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch {
    return
  }

  try {
    const text = readFileSync(path, "utf8")
    const lines = text.split("\n").filter(Boolean)
    if (lines.length < COMPACT_THRESHOLD) return
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    const kept = lines.filter((line) => {
      const parsed = parseLine(line)
      return parsed ? parsed.at >= cutoff : false
    })
    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "")
  } catch {
    /* 压缩失败就留着，下次再试 */
  }
}

/**
 * 窗口起点。
 *
 * resetsAt 是窗口结束时间，往前推窗口长度就是起点。
 * 月窗口按 30 天近似——Go 的账单周期是自然月，但账本只用来估算，
 * 差一两天不影响「用了多少」的量级。
 */
export function windowSince(resetsAt: number, window: "rolling" | "weekly" | "monthly"): number {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return 0
  const span =
    window === "rolling" ? 5 * 3_600_000 : window === "weekly" ? 7 * 86_400_000 : 30 * 86_400_000
  return resetsAt - span
}

/** 某个时间点之后、某个模型（可选）的配额总和。 */
export function sumSince(entries: readonly Entry[], since: number, model?: string): number {
  let total = 0
  for (const entry of entries) {
    if (entry.at < since) continue
    if (model && entry.model !== model) continue
    total += entry.allowance
  }
  return total
}

/**
 * 账本里出现过的模型及其在窗口内的消耗，按消耗降序。
 *
 * 用于「当前模型不在账本里」时给一个参考：至少知道别的模型花了多少。
 */
export function byModelSince(
  entries: readonly Entry[],
  since: number,
): Array<{ model: string; allowance: number }> {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.at < since) continue
    totals.set(entry.model, (totals.get(entry.model) ?? 0) + entry.allowance)
  }
  return [...totals.entries()]
    .map(([model, allowance]) => ({ model, allowance }))
    .sort((a, b) => b.allowance - a.allowance)
}
