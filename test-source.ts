/**
 * 用 Bun 验证插件的数据源链路：bun:sqlite 能读 credential 表，key 能调通 go/status。
 *
 * 这个脚本不进 dist，只在开发时手动跑：
 *   bun test-source.ts
 */

import { Database } from "bun:sqlite"

const DB = `${process.env.USERPROFILE}\\.local\\share\\opencode\\opencode.db`

const db = new Database(DB, { readonly: true })
const row = db.query("select value from credential where integration_id = 'opencode-go' limit 1").get() as
  | { value: string }
  | null
db.close()

if (!row) {
  console.log("credential 表里没有 opencode-go")
  process.exit(1)
}

const key = JSON.parse(row.value).key as string
console.log("key 前缀:", key.slice(0, 14) + "…", "长度", key.length)

const res = await fetch("https://opencode.ai/console/api/go/status", {
  headers: {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "User-Agent": "opencode-go-usage/0.1",
  },
})
console.log("HTTP", res.status)
if (!res.ok) {
  console.log(await res.text())
  process.exit(1)
}

const body: any = await res.json()
const meters = body?.access?.meters
for (const [name, m] of Object.entries<any>(meters ?? {})) {
  const limit = Number(m.limitMicroCents ?? 0)
  const used = Number(m.usedMicroCents ?? 0)
  console.log(
    `${name.padEnd(10)} $${(used / 1e8).toFixed(4)} / $${(limit / 1e8).toFixed(2)}  ` +
      `${((used / limit) * 100).toFixed(2)}%  resets ${m.resetsAt}`,
  )
}
