/**
 * limits.ts 的纯逻辑测试。
 *
 * 重点覆盖三类容易错的地方：
 * 1. 「先撞墙」的判断边界（等于账户额度算不算撞墙）
 * 2. 进度条的格子数（少一格多一格在窄面板里很难看）
 * 3. 倒计时跨天/跨小时的进位
 *
 * 运行：npm test（verify 会先 build）
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  bar,
  bottlenecks,
  countdown,
  fillPercent,
  formatPercent,
  formatUsd,
  GO_ACCOUNT,
  GO_MONTHLY,
  level,
  modelWindows,
  normalizeMeter,
  overall,
  overallLabel,
} from "../dist/limits.js"

// ---------- modelWindows ----------

test("modelWindows: 5h 是月额度的 20%，周是 50%", () => {
  const w = modelWindows(60)
  assert.equal(w.rolling, 12)
  assert.equal(w.weekly, 30)
  assert.equal(w.monthly, 60)
})

test("modelWindows: 月额度 15 的模型三窗口都低于账户额度", () => {
  const w = modelWindows(15)
  assert.equal(w.rolling, 3)
  assert.equal(w.weekly, 7.5)
  assert.ok(w.rolling < GO_ACCOUNT.rolling)
  assert.ok(w.weekly < GO_ACCOUNT.weekly)
  assert.ok(w.monthly < GO_ACCOUNT.monthly)
})

// ---------- bottlenecks ----------

test("bottlenecks: 月额度等于账户额度的模型不算撞墙", () => {
  // GLM-5.3-Flash 是 $60，和账户月额度相同，三窗口刚好持平，不该出现在列表里
  const list = bottlenecks(GO_ACCOUNT)
  assert.ok(!list.some((item) => item.id === "glm-5.3-flash"))
})

test("bottlenecks: 月额度低于账户的模型全部命中", () => {
  const list = bottlenecks(GO_ACCOUNT)
  for (const item of list) {
    assert.ok(item.monthly < GO_ACCOUNT.monthly, `${item.id} 月额度 ${item.monthly} 不该命中`)
  }
})

test("bottlenecks: 按月额度升序，最先撞墙的排最前", () => {
  const list = bottlenecks(GO_ACCOUNT)
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].monthly <= list[i].monthly)
  }
  assert.ok(list[0].monthly <= 15, `第一个应该是 $15 档，实际 ${list[0].monthly}`)
})

test("bottlenecks: 空表返回空数组", () => {
  assert.deepEqual(bottlenecks(GO_ACCOUNT, {}), [])
})

test("bottlenecks: 自定义账户额度会改变命中结果", () => {
  // 账户额度调到 $200 时，连 DeepSeek V4.1 Flash（$100）也算撞墙
  const list = bottlenecks({ rolling: 40, weekly: 100, monthly: 200 })
  assert.ok(list.some((item) => item.id === "deepseek-v4.1-flash"))
})

test("GO_MONTHLY: 每个值都是正数", () => {
  for (const [id, value] of Object.entries(GO_MONTHLY)) {
    assert.ok(Number.isFinite(value) && value > 0, `${id} 的额度不合法: ${value}`)
  }
})

// ---------- bar ----------

test("bar: 0% 全是空格线", () => {
  assert.equal(bar(0, 10), "----------")
})

test("bar: 100% 全满", () => {
  assert.equal(bar(100, 10), "##########")
})

test("bar: 50% 正好一半", () => {
  assert.equal(bar(50, 10), "#####-----")
})

test("bar: 总宽度恒等于参数", () => {
  for (const percent of [0, 1, 33.3, 50, 99.9, 100]) {
    assert.equal(bar(percent, 12).length, 12)
  }
})

test("bar: 超过 100 会截断而不是撑长", () => {
  assert.equal(bar(150, 10).length, 10)
  assert.equal(bar(150, 10), "##########")
})

test("bar: 负数当 0 处理", () => {
  assert.equal(bar(-5, 10), "----------")
})

// ---------- level ----------

test("level: 75 以下正常", () => {
  assert.equal(level(0), "ok")
  assert.equal(level(74.9), "ok")
})

test("level: 75 起警告", () => {
  assert.equal(level(75), "warn")
  assert.equal(level(89.9), "warn")
})

test("level: 90 起危险", () => {
  assert.equal(level(90), "danger")
  assert.equal(level(100), "danger")
})

// ---------- countdown ----------

test("countdown: 已经到期显示 now", () => {
  assert.equal(countdown(1000, 2000), "now")
  assert.equal(countdown(1000, 1000), "now")
})

test("countdown: 不足一小时只显示分钟", () => {
  assert.equal(countdown(0, -30 * 60_000), "30m")
})

test("countdown: 超过一小时显示时分", () => {
  assert.equal(countdown(0, -90 * 60_000), "1h 30m")
})

test("countdown: 超过一天显示天和小时", () => {
  assert.equal(countdown(0, -((26 * 60 + 5) * 60_000)), "1d 2h")
})

test("countdown: resetsAt 非有限值时显示 now", () => {
  assert.equal(countdown(NaN, 0), "now")
})

// ---------- formatPercent ----------

test("formatPercent: 0 显示 0%", () => {
  assert.equal(formatPercent(0), "0.0%")
})

test("formatPercent: 10% 以下保留一位小数", () => {
  assert.equal(formatPercent(0.7), "0.7%")
  assert.equal(formatPercent(0.04), "0.0%")
  assert.equal(formatPercent(2), "2.0%")
  assert.equal(formatPercent(9.94), "9.9%")
})

test("formatPercent: 10% 以上取整", () => {
  assert.equal(formatPercent(12.4), "12%")
  assert.equal(formatPercent(99.9), "100%")
})

test("formatPercent: 非有限值显示问号", () => {
  assert.equal(formatPercent(NaN), "?")
})

// ---------- formatUsd ----------

test("formatUsd: 保留两位小数", () => {
  assert.equal(formatUsd(12), "$12.00")
  assert.equal(formatUsd(7.5), "$7.50")
  assert.equal(formatUsd(0.0043), "$0.00")
})

// ---------- normalizeMeter ----------

test("normalizeMeter: 缺字段时给出安全默认值", () => {
  assert.deepEqual(normalizeMeter({}), { percent: 0, limited: false, resetsAt: 0 })
})

test("normalizeMeter: 负数百分比归零", () => {
  assert.equal(normalizeMeter({ percent: -3 }).percent, 0)
})

test("normalizeMeter: 保留 limited 和 resetsAt", () => {
  const m = normalizeMeter({ percent: 42, limited: true, resetsAt: 123 })
  assert.deepEqual(m, { percent: 42, limited: true, resetsAt: 123 })
})

// ---------- overall ----------

/** 造一个 meter，只关心 percent 和 limited。 */
const meter = (percent, limited = false) => ({ percent, limited, resetsAt: 0 })

test("overall: 三个窗口都低时正常", () => {
  assert.equal(overall({ rolling: meter(1), weekly: meter(2), monthly: meter(3) }), "ok")
})

test("overall: 任一窗口到 75 就警告", () => {
  assert.equal(overall({ rolling: meter(75), weekly: meter(1), monthly: meter(1) }), "warn")
})

test("overall: 任一窗口到 90 就危险", () => {
  assert.equal(overall({ rolling: meter(1), weekly: meter(90), monthly: meter(1) }), "danger")
})

test("overall: limited 优先于百分比", () => {
  assert.equal(overall({ rolling: meter(1, true), weekly: meter(1), monthly: meter(1) }), "limited")
})

test("overallLabel: 四种状态都有文案", () => {
  assert.equal(overallLabel("ok"), "正常")
  assert.equal(overallLabel("warn"), "接近上限")
  assert.equal(overallLabel("danger"), "即将限流")
  assert.equal(overallLabel("limited"), "已限流")
})

// ---------- fillPercent ----------

test("fillPercent: 0 返回 0，不画格子", () => {
  assert.equal(fillPercent(0, 14), 0)
})

test("fillPercent: 极小值至少给一格，否则渲染不出来", () => {
  assert.equal(fillPercent(0.9, 14), 100 / 14)
})

test("fillPercent: 正常值原样返回", () => {
  assert.equal(fillPercent(50, 14), 50)
})

test("fillPercent: 超过 100 截断到 100", () => {
  assert.equal(fillPercent(150, 14), 100)
})

test("fillPercent: 非法输入返回 0", () => {
  assert.equal(fillPercent(NaN, 14), 0)
  assert.equal(fillPercent(50, 0), 0)
})
