import { Plugin } from "@opencode/plugin"

import { appendEntry } from "./ledger.js"

/**
 * 从响应体里挖出这一笔的 Go 配额消耗。
 *
 * 流式响应是 SSE，每条 `data: {...}`；非流式（比如报错）整个 body 就是一个 JSON。
 * 两种情况都要认，因为失败请求也可能带 usage。
 */
function extractAllowance(text: string): number | null {
  const trimmed = text.trim()

  // 非流式：整个 body 是一个 JSON 对象
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed)
      const allowance = value?.usage?.opencode?.allowance
      if (typeof allowance === "number" && allowance > 0) return allowance
    } catch {
      /* 不是 JSON，继续按 SSE 解析 */
    }
  }

  // SSE：取最后一条带 allowance 的 data 行
  let found: number | null = null
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const value = JSON.parse(payload)
      const allowance = value?.usage?.opencode?.allowance
      if (typeof allowance === "number" && allowance > 0) found = allowance
    } catch {
      /* 单行解析失败不影响其他行 */
    }
  }
  return found
}

/**
 * 服务端入口：把每笔 Go 请求的配额消耗记进账本。
 *
 * 不 await 响应体：hook 必须立刻返回，否则会把首字节推迟到整个流结束。
 * clone() 是 tee，原流照常走，我们只在后台读副本。
 */
export default Plugin.define({
  id: "opencode-go-gauge",
  async setup(context) {
    await context.session.hook(
      "http.response",
      (input) => {
        const clone = input.response.clone()
        void (async () => {
          try {
            const text = await clone.text()
            const allowance = extractAllowance(text)
            if (allowance === null) return
            const model = String((input.model as { id?: string })?.id ?? "")
            if (!model) return
            appendEntry({ at: Date.now(), model, allowance, kind: input.kind })
          } catch {
            /* 解析失败不影响请求本身 */
          }
        })()
      },
      { providerID: "opencode-go" },
    )
  },
})
