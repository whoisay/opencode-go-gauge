/**
 * ledger.ts 的纯逻辑测试。
 *
 * 账本是「按模型已用多少」的唯一数据来源，算错了会让面板显示假的配额消耗，
 * 所以过滤、求和、窗口边界都要覆盖。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { byModelSince, parseLedger, parseLine, sumSince, windowSince } from "../dist/ledger.js"

const HOUR = 3_600_000
const DAY = 86_400_000

// ---------- parseLine ----------

test("parseLine: 合法记录能解析", () => {
  const entry = parseLine('{"at":1000,"model":"glm-5.3","allowance":0.01,"kind":"primary"}')
  assert.deepEqual(entry, { at: 1000, model: "glm-5.3", allowance: 0.01, kind: "primary" })
})

test("parseLine: 空行返回 null", () => {
  assert.equal(parseLine(""), null)
  assert.equal(parseLine("   "), null)
})

test("parseLine: 坏 JSON 返回 null 而不是抛错", () => {
  assert.equal(parseLine("{not json"), null)
})

test("parseLine: allowance 为 0 的记录丢弃", () => {
  // 免费模型和账户内请求的 allowance 是 0，记了也没意义
  assert.equal(parseLine('{"at":1,"model":"x","allowance":0}'), null)
})

test("parseLine: allowance 为负数的记录丢弃", () => {
  assert.equal(parseLine('{"at":1,"model":"x","allowance":-0.5}'), null)
})

test("parseLine: 缺 kind 时默认 primary", () => {
  const entry = parseLine('{"at":1,"model":"x","allowance":0.1}')
  assert.equal(entry?.kind, "primary")
})

// ---------- parseLedger ----------

test("parseLedger: 多行混合，只保留合法的", () => {
  const text = [
    '{"at":1,"model":"a","allowance":0.1}',
    "",
    "garbage",
    '{"at":2,"model":"b","allowance":0.2}',
  ].join("\n")
  const entries = parseLedger(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].model, "a")
  assert.equal(entries[1].model, "b")
})

test("parseLedger: 空文本返回空数组", () => {
  assert.deepEqual(parseLedger(""), [])
})

// ---------- windowSince ----------

test("windowSince: 5h 窗口往前推 5 小时", () => {
  const resetsAt = 10 * HOUR
  assert.equal(windowSince(resetsAt, "rolling"), 5 * HOUR)
})

test("windowSince: 周窗口往前推 7 天", () => {
  const resetsAt = 10 * DAY
  assert.equal(windowSince(resetsAt, "weekly"), 3 * DAY)
})

test("windowSince: 月窗口按 30 天算", () => {
  const resetsAt = 40 * DAY
  assert.equal(windowSince(resetsAt, "monthly"), 10 * DAY)
})

test("windowSince: 非法 resetsAt 返回 0", () => {
  assert.equal(windowSince(0, "rolling"), 0)
  assert.equal(windowSince(NaN, "weekly"), 0)
})

// ---------- sumSince ----------

test("sumSince: 只算起点之后的记录", () => {
  const entries = [
    { at: 100, model: "a", allowance: 0.1, kind: "primary" },
    { at: 200, model: "a", allowance: 0.2, kind: "primary" },
  ]
  assert.equal(sumSince(entries, 150), 0.2)
})

test("sumSince: 指定模型时只算该模型", () => {
  const entries = [
    { at: 100, model: "a", allowance: 0.1, kind: "primary" },
    { at: 100, model: "b", allowance: 0.3, kind: "primary" },
  ]
  assert.equal(sumSince(entries, 0, "a"), 0.1)
})

test("sumSince: 空数组返回 0", () => {
  assert.equal(sumSince([], 0), 0)
})

test("sumSince: 起点正好等于记录时间时算进去", () => {
  const entries = [{ at: 100, model: "a", allowance: 0.5, kind: "primary" }]
  assert.equal(sumSince(entries, 100), 0.5)
})

// ---------- byModelSince ----------

test("byModelSince: 按模型聚合且降序", () => {
  const entries = [
    { at: 100, model: "a", allowance: 0.1, kind: "primary" },
    { at: 100, model: "b", allowance: 0.5, kind: "primary" },
    { at: 100, model: "a", allowance: 0.2, kind: "primary" },
  ]
  const result = byModelSince(entries, 0)
  assert.deepEqual(result, [
    { model: "b", allowance: 0.5 },
    { model: "a", allowance: 0.30000000000000004 },
  ])
})

test("byModelSince: 起点之前的记录不计入", () => {
  const entries = [
    { at: 10, model: "a", allowance: 1, kind: "primary" },
    { at: 100, model: "b", allowance: 0.5, kind: "primary" },
  ]
  assert.deepEqual(byModelSince(entries, 50), [{ model: "b", allowance: 0.5 }])
})

test("byModelSince: 空数组返回空", () => {
  assert.deepEqual(byModelSince([], 0), [])
})

// ---------- 窗口滚动 ----------

test("窗口滚动后旧记录被排除", () => {
  // 第一窗口 0-5h 记了 $0.10，第二窗口 5-10h 记了 $0.20
  const entries = [
    { at: 1 * HOUR, model: "a", allowance: 0.1, kind: "primary" },
    { at: 6 * HOUR, model: "a", allowance: 0.2, kind: "primary" },
  ]

  // 第二个窗口：resetsAt = 10h，起点 5h，第一笔被排除，只剩 $0.20
  assert.ok(Math.abs(sumSince(entries, windowSince(10 * HOUR, "rolling")) - 0.2) < 1e-9)

  // 再往后一个窗口：resetsAt = 15h，起点 10h，两笔都被排除
  assert.equal(sumSince(entries, windowSince(15 * HOUR, "rolling")), 0)
})

test("窗口滚动后当前模型的消耗会归零", () => {
  // 这是「按时重置」的核心断言：没有新记录时，新窗口的合计就是 0
  const entries = [{ at: 1 * HOUR, model: "a", allowance: 0.5, kind: "primary" }]
  const nextWindowSince = windowSince(15 * HOUR, "rolling") // 起点 10h
  assert.equal(sumSince(entries, nextWindowSince, "a"), 0)
})
