/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { desaturateTo, FALLBACK, MAX_SAT } from "./color.js"
import { byModelSince, readLedger, windowSince, type Entry } from "./ledger.js"
import {
  countdown,
  fillPercent,
  formatPercent,
  formatUsdFine,
  level,
  overall,
  overallLabel,
  type Meter,
  type Window,
} from "./limits.js"
import { fetchGoMeters, modelSlug, type GoMeters } from "./source.js"

/** 拉取间隔。Go 的百分比变化很慢，60 秒足够，也不至于把接口打热。 */
const POLL_MS = 60_000
/** 倒计时单独刷新，比轮询快一倍，看起来才像在走。 */
const CLOCK_MS = 30_000
/** 进度条格子数。 */
const BAR_CELLS = 14
/** 标签列宽。week 最长 4 字符，留 2 格空隙。 */
const LABEL_WIDTH = 6
/** 持久化 key，和插件 id 一致，换插件时不会串。 */
const STORAGE_KEY = "opencode-go-gauge"

const LABELS: Record<Window, string> = {
  rolling: "5h",
  weekly: "week",
  monthly: "month",
}

const WINDOWS: Window[] = ["rolling", "weekly", "monthly"]

/**
 * 虚线边框字符集。
 *
 * OpenTUI 的 BorderStyle 只有 single/double/rounded/heavy，没有 dashed。
 * 但 Box 支持 customBorderChars，把 horizontal 换成 "-" 就能得到虚线，
 * 而且宽度由容器决定，自适应铺满，不用手数格子。
 */
const DASHED = {
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  horizontal: "-",
  vertical: " ",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
}

function Panel(props: { context: Context }) {
  // 颜色必须用 memo 包一层：主题切换时 context.theme 会变，
  // 直接写成 const 只会在组件初始化时算一次，之后永远停在旧主题上。
  const baseColor = createMemo(() => desaturateTo(props.context.theme.text.base, MAX_SAT, FALLBACK.text))
  const mutedColor = createMemo(() => desaturateTo(props.context.theme.text.muted, MAX_SAT, FALLBACK.muted))
  const faintColor = createMemo(() => desaturateTo(props.context.theme.text.faint, MAX_SAT, FALLBACK.border))
  // accent 取主题主色。注意不能取 text.action.primary.base——
  // 那个在主题定义里就是 $text.base（白），是按钮文字色，不是主色。
  // 主色在 selected 状态：action.primary.$selected = $hue.interactive.200。
  const accent = createMemo(() => {
    const action = props.context.theme.text.action.primary
    const raw = action.selected ?? action.focused
    return raw ? desaturateTo(raw, MAX_SAT, FALLBACK.warning) : FALLBACK.warning
  })
  const okColor = createMemo(() =>
    desaturateTo(props.context.theme.text.feedback.success.base, MAX_SAT, FALLBACK.success),
  )
  const warnColor = createMemo(() =>
    desaturateTo(props.context.theme.text.feedback.warning.base, MAX_SAT, FALLBACK.warning),
  )
  const errColor = createMemo(() =>
    desaturateTo(props.context.theme.text.feedback.error.base, MAX_SAT, FALLBACK.error),
  )
  const trackColor = createMemo(() =>
    desaturateTo(props.context.theme.background.raised.high, MAX_SAT, FALLBACK.border),
  )

  // 折叠状态存进宿主 KV，重载和重启都保留
  const [prefs, setPrefs] = props.context.storage.store(STORAGE_KEY, {
    initial: { open: true },
  })

  const [meters, setMeters] = createSignal<GoMeters | null>(null)
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())

  let alive = true

  const load = async () => {
    // 账本和接口是两条独立的数据源，账本读失败不该拖垮配额显示
    setEntries(readLedger())

    // 先试宿主自带的接口：有 Console 登录态时它能直接给 go 字段。
    // 本机只有 API key，这个分支通常拿不到，所以下面还有一条 API 兜底。
    try {
      const res = await props.context.client.experimental.usage.limits()
      const go = res.data?.go
      if (go) {
        if (!alive) return
        setMeters({
          rolling: { percent: go.rolling.percent, limited: go.rolling.limited, resetsAt: go.rolling.resetsAt },
          weekly: { percent: go.weekly.percent, limited: go.weekly.limited, resetsAt: go.weekly.resetsAt },
          monthly: { percent: go.monthly.percent, limited: go.monthly.limited, resetsAt: go.monthly.resetsAt },
        })
        setError(null)
        return
      }
    } catch {
      /* 宿主接口不可用时静默降级，错误交给下面那条路报 */
    }

    const result = await fetchGoMeters()
    if (!alive) return
    if (result.kind === "ok") {
      setMeters(result.meters)
      setError(null)
      return
    }
    setError(result.message)
  }

  void load()
  const poll = setInterval(load, POLL_MS)
  const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)
  onCleanup(() => {
    alive = false
    clearInterval(poll)
    clearInterval(clock)
  })

  // 当前模型，响应式：切到非 Go 模型时整块隐藏
  const current = createMemo(() => props.context.ui.model.current())
  const slug = createMemo(() => modelSlug(current()?.providerID, current()?.modelID))

  const state = createMemo(() => (meters() ? overall(meters()!) : null))

  /**
   * 账本里每个模型在 5 小时窗口内的消耗。
   *
   * 只给消耗不给分母：官方文档说每个模型有自己的额度（月额度的 20%/50%/100%），
   * 但实际实现是所有付费模型共享账户级的单一池（issue #60311、#54875），
   * 耗尽任何一个模型的窗口会锁住全部模型。给单模型分母会误导。
   */
  const perModel = createMemo(() => {
    const value = meters()
    if (!value) return []
    const since = windowSince(value.rolling.resetsAt, "rolling")
    return byModelSince(entries(), since)
  })

  const statusColor = () => {
    const value = state()
    if (value === "limited" || value === "danger") return errColor()
    if (value === "warn") return warnColor()
    return okColor()
  }

  const barColor = (percent: number) => {
    const value = level(percent)
    if (value === "danger") return errColor()
    if (value === "warn") return warnColor()
    return okColor()
  }

  const toggle = () => {
    void setPrefs((draft) => {
      draft.open = !draft.open
    })
  }

  return (
    <Show when={slug()}>
      <box flexDirection="column">
        <box flexDirection="row" height={1}>
          <box flexGrow={1}>
            <text fg={baseColor()}>
              <b>Go 用量</b>
            </text>
          </box>
          <Show when={state()}>
            <text fg={statusColor()}>{overallLabel(state()!)}</text>
          </Show>
        </box>

        <Show when={meters()}>
          <For each={WINDOWS}>
            {(key) => {
              const meter = () => meters()![key] as Meter
              return (
                <box flexDirection="row" height={1}>
                  <text fg={mutedColor()}>{LABELS[key].padEnd(LABEL_WIDTH)}</text>
                  {/* 轨道用 raised.high：raised.base 和面板背景几乎同色，
                      空条看不出来，只剩填充那一点绿，像坏了 */}
                  <box width={BAR_CELLS} height={1} backgroundColor={trackColor()}>
                    <box
                      width={`${fillPercent(meter().percent, BAR_CELLS)}%`}
                      height={1}
                      backgroundColor={barColor(meter().percent)}
                    />
                  </box>
                  {/* 百分比是数据值（L3），用 base 而不是 muted；
                      标签才是 muted。之前两者同色，值看起来不像值 */}
                  <text fg={baseColor()}>{`  ${formatPercent(meter().percent).padStart(5)}`}</text>
                  <text fg={faintColor()}>{`   ${countdown(meter().resetsAt, now())}`}</text>
                </box>
              )
            }}
          </For>
        </Show>

        <Show when={!meters() && !error()}>
          <text fg={mutedColor()}>读取中…</text>
        </Show>

        <Show when={!meters() && error()}>
          <text fg={errColor()}>{`! ${error()}`}</text>
        </Show>

        <Show when={perModel().length > 0}>
          {/* 只用上边框，字符换成 "-"，宽度跟随容器自适应 */}
          <box height={1} border={["top"]} borderColor={faintColor()} customBorderChars={DASHED} />
          <box onMouseDown={toggle}>
            <text fg={baseColor()}>
              <b>{`${prefs.open ? "▼" : "▶"} 模型 · 5h 消耗 (${perModel().length})`}</b>
            </text>
          </box>
          <Show when={prefs.open}>
            <For each={perModel()}>
              {(row) => (
                <box flexDirection="row" height={1}>
                  <box flexGrow={1}>
                    <text fg={row.model === slug() ? accent() : mutedColor()}>{`  ${row.model}`}</text>
                  </box>
                  <text fg={row.model === slug() ? accent() : mutedColor()}>
                    {formatUsdFine(row.allowance)}
                  </text>
                </box>
              )}
            </For>
            <text fg={faintColor()}>· 所有模型共享账户额度</text>
          </Show>
        </Show>

        <Show when={perModel().length === 0}>
          <text fg={faintColor()}>账本为空，装插件后开始统计</text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-go-gauge",
  setup(context) {
    context.ui.slot({
      // prepend 而不是 append：放侧边栏最上面，不会因为下面 todo/context
      // 变多而被挤下去，位置固定。
      prepend: "sidebar.content",
      render: () => <Panel context={context} />,
    })
  },
})
