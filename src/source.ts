/**
 * Go 配额的数据源。
 *
 * 为什么不用宿主自带的 `client.experimental.usage.limits()`：
 * 那个接口依赖 Console 登录态（control_account 表），而本机只有 API key，
 * 所以 `data.go` 永远是 undefined。实测过，面板会一直显示「未订阅」。
 *
 * 这里改走 `console/api/go/status`，用 API key 认证。它返回的是 micro-cents，
 * 比 `zen/go/v1/usage` 的取整百分比精确，能显示 0.7% 这种小数。
 *
 * key 从 OpenCode 自己的 SQLite 里读，不落任何新文件。
 */

import { homedir } from "node:os"
import { join } from "node:path"

import { normalizeMeter, type Meter, type Window } from "./limits.js"

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
const STATUS_URL = "https://opencode.ai/console/api/go/status"

export type GoMeters = Record<Window, Meter>

export type FetchResult =
  | { kind: "ok"; meters: GoMeters }
  | { kind: "none"; message: string }
  | { kind: "error"; message: string }

/**
 * 从 credential 表读 opencode-go 的 key。
 *
 * 表结构是 OpenCode v2 的：integration_id + value(JSON)。旧版本把 key 放在
 * auth.json，那个文件可能是过期副本（实测踩过 401 api_key_expired），
 * 所以这里只认数据库。
 */
async function readKey(): Promise<string | null> {
  try {
    // bun:sqlite 在 OpenCode 的运行时里可用；在纯 Node 环境下不存在，
    // 所以用动态 import 包住，失败就走 error 分支而不是让整个模块挂掉。
    const mod: any = await import("bun:sqlite" as string)
    const db = new mod.Database(DB_PATH, { readonly: true })
    try {
      const row = db
        .query("select value from credential where integration_id = 'opencode-go' limit 1")
        .get() as { value?: string } | null
      if (!row?.value) return null
      const parsed = JSON.parse(row.value)
      return typeof parsed?.key === "string" && parsed.key.length > 0 ? parsed.key : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** meter 的 micro-cents 是十进制字符串，1e8 = $1。 */
function meterFrom(raw: any): Meter {
  const limit = Number(raw?.limitMicroCents ?? 0)
  const used = Number(raw?.usedMicroCents ?? 0)
  return normalizeMeter({
    percent: limit > 0 ? (used / limit) * 100 : 0,
    limited: false,
    resetsAt: typeof raw?.resetsAt === "string" ? Date.parse(raw.resetsAt) : 0,
  })
}

/**
 * 拉一次 Go 配额。
 *
 * 失败分类是为了 UI 能说清楚原因：没有 key、key 过期、网络不通是三件事，
 * 混成一个「加载失败」用户没法处理。
 */
export async function fetchGoMeters(): Promise<FetchResult> {
  const key = await readKey()
  if (!key) {
    return { kind: "none", message: "没找到 opencode-go 的 key，先 /connect 一次" }
  }

  let response: Response
  try {
    response = await fetch(STATUS_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "opencode-go-gauge/0.1",
      },
    })
  } catch (cause) {
    return { kind: "error", message: `网络不通：${cause instanceof Error ? cause.message : cause}` }
  }

  if (response.status === 401) {
    return { kind: "error", message: "key 已过期，去 Console 重新创建" }
  }
  if (response.status === 403) {
    return { kind: "none", message: "这个账号没有 Go 订阅" }
  }
  if (!response.ok) {
    return { kind: "error", message: `接口返回 ${response.status}` }
  }

  let body: any
  try {
    body = await response.json()
  } catch {
    return { kind: "error", message: "接口返回的不是 JSON" }
  }

  const meters = body?.access?.meters
  if (!meters) {
    return { kind: "none", message: "响应里没有 meters 字段" }
  }

  return {
    kind: "ok",
    meters: {
      rolling: meterFrom(meters.fiveHour),
      weekly: meterFrom(meters.week),
      monthly: meterFrom(meters.month),
    },
  }
}

/** 从模型 ID 里剥掉 provider 前缀，`opencode-go/glm-5.3` -> `glm-5.3`。 */
export function modelSlug(providerID: string | undefined, modelID: string | undefined): string | null {
  if (!providerID || !modelID) return null
  if (providerID !== "opencode-go") return null
  return modelID
}
