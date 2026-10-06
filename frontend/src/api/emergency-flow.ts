import { listRows, saveRows } from '@/data/local-store'
import { moduleMeta, runAction } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'

// 应急处置链路编排：升级建议的生成、采纳、退回、时限补录与断点续传都放在这里，
// 页面只负责渲染。通用状态流转仍在 local-service.ts，这里只做应急特有的跨模块编排。

/** 受影响管段排查事项的数据 key：不注册为业务模块，只作为数据表挂在本地存储里 */
export const CHECK_KEY = 'emergency_check'

/** 处置链路：接报 → 启动响应 → 制定方案 → 确认处置，与模块 statuses 一一对应 */
export const CHAIN_STEPS = ['接报', '启动响应', '制定方案', '确认处置'] as const

/** 排查事项自身的流转：待排查 → 排查中 → 已排查，同样只能依次推进 */
export const CHECK_FLOW = ['待排查', '排查中', '已排查'] as const

export const CHECK_NEXT_LABEL: Record<string, string> = {
  待排查: '开始排查',
  排查中: '确认排查',
}

/** 采纳流程的进度标记：空 → 状态已推进 → 排查已生成 → 缺陷已关联（完成） */
const ACCEPT_STEPS = ['状态已推进', '排查已生成', '缺陷已关联'] as const
type AcceptProgress = '' | (typeof ACCEPT_STEPS)[number]

/** 每一步的下一步说明，用于断点恢复时告诉操作员从哪一步继续 */
const STEP_LABEL: Record<AcceptProgress, string> = {
  '': '推进事件状态',
  状态已推进: '生成受影响管段排查事项',
  排查已生成: '保留关联缺陷',
  缺陷已关联: '已完成',
}

const HAZARD_WEIGHT: Record<string, number> = { 重大: 3, 较大: 2, 一般: 1 }

export type Advice = {
  /** 1 时限关注 / 2 时限临期 / 3 已超时 */
  level: number
  levelLabel: string
  text: string
  nextAction: string
  nextStatus: string
}

function progressOf(row: EntryRow): AcceptProgress {
  const value = String(row['采纳进度'] ?? '')
  return (ACCEPT_STEPS as readonly string[]).includes(value) ? (value as AcceptProgress) : ''
}

/** 处置时限按小时数解析：接受 "12"、"12小时" 等写法，空值或无法解析返回 null（历史遗留） */
export function parseHours(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!text) {
    return null
  }
  const match = text.match(/(\d+(?:\.\d+)?)/)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10
  if (rounded >= 24) {
    const days = Math.floor(rounded / 24)
    const rest = Math.round((rounded - days * 24) * 10) / 10
    return rest > 0 ? `${days}天${rest}小时` : `${days}天`
  }
  return `${rounded}小时`
}

function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function splitCodes(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function findEmergency(id: number): EntryRow | undefined {
  return listRows('emergency').find((row) => Number(row.id) === id)
}

function updateEmergency(id: number, patch: Record<string, string | number | boolean>): void {
  const rows = listRows('emergency')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows('emergency', next)
}

/** 当前状态的下一个流转动作；已到「已处置」返回 null */
export function nextActionOf(row: EntryRow): { action: string; target: string } | null {
  const meta = moduleMeta('emergency')
  const index = meta.statuses.indexOf(String(row.status))
  if (index < 0 || index >= meta.statuses.length - 1) {
    return null
  }
  const target = meta.statuses[index + 1]
  const action = Object.keys(meta.actionTargets).find((name) => meta.actionTargets[name] === target)
  return action ? { action, target } : null
}

/**
 * 按时限和危害等级生成升级建议。
 * 历史事件缺少处置时限时返回 null（页面上引导补录，补录后重算）；
 * 已退回的建议只在紧迫级别上升时重新出现。
 */
export function buildAdvice(row: EntryRow, now: Date = new Date()): Advice | null {
  if (String(row.status) === '已处置') {
    return null
  }
  const hours = parseHours(row['处置时限'])
  if (hours === null) {
    return null
  }
  const reportedAt = new Date(String(row['接报时间'] ?? '').replace(' ', 'T'))
  if (Number.isNaN(reportedAt.getTime())) {
    return null
  }
  const remaining = (reportedAt.getTime() + hours * 3600_000 - now.getTime()) / 3600_000
  const hazard = HAZARD_WEIGHT[String(row['危害等级'])] ?? 1
  let level = 0
  if (remaining < 0) {
    level = 3
  } else if (remaining <= hours * 0.25) {
    level = 2
  } else if (remaining <= hours * 0.5 && hazard >= 2) {
    level = 1
  }
  if (level === 0) {
    return null
  }
  if (String(row['建议状态'] ?? '') === '已退回' && level <= Number(row['退回级别'] ?? 0)) {
    return null
  }
  const next = nextActionOf(row)
  if (!next) {
    return null
  }
  const levelLabel = ['', '时限关注', '时限临期', '已超时'][level]
  const text =
    level === 3
      ? `已超出处置时限 ${formatHours(-remaining)}，危害等级「${row['危害等级']}」，建议立即${next.action}`
      : `距处置时限仅剩 ${formatHours(remaining)}，危害等级「${row['危害等级']}」，建议${next.action}`
  return { level, levelLabel, text, nextAction: next.action, nextStatus: next.target }
}

/** 退回建议：记录退回时的级别，时限进一步紧张（级别上升）时会再次提醒 */
export function rejectAdvice(id: number): ActionResult {
  const row = findEmergency(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  const advice = buildAdvice(row)
  if (!advice) {
    return { ok: false, message: '当前没有可退回的升级建议' }
  }
  updateEmergency(id, { 建议状态: '已退回', 退回级别: advice.level })
  return { ok: true, message: `已退回事件 ${row['事件编号']} 的升级建议，时限进一步紧张时会再次提醒` }
}

/** 补录处置时限：历史事件允许补录，保存后清空退回记录，建议自动重算 */
export function supplementDeadline(id: number, hours: number): ActionResult {
  const row = findEmergency(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    return { ok: false, message: '处置时限需为大于 0 的小时数' }
  }
  updateEmergency(id, { 处置时限: String(hours), 建议状态: '', 退回级别: 0 })
  return { ok: true, message: `事件 ${row['事件编号']} 已补录处置时限 ${hours} 小时，升级建议已重算` }
}

/** 第二步：为受影响管段生成排查事项。按「来源事件 + 管段编号」去重，断点续传时不会重复生成 */
function generateChecks(id: number): void {
  const row = findEmergency(id)
  if (!row) {
    return
  }
  const segments = splitCodes(row['受影响管段'])
  if (!segments.length) {
    return
  }
  const eventCode = String(row['事件编号'])
  const checks = listRows(CHECK_KEY)
  let nextId = checks.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const added: EntryRow[] = []
  for (const segment of segments) {
    const exists = checks.some(
      (item) => String(item['来源事件']) === eventCode && String(item['管段编号']) === segment,
    )
    if (exists) {
      continue
    }
    const checkId = nextId++
    added.push({
      id: checkId,
      status: '待排查',
      pending: true,
      abnormal: false,
      事项编号: `CHEC-${String(checkId).padStart(4, '0')}`,
      来源事件: eventCode,
      管段编号: segment,
      排查要求: `应急事件 ${eventCode}（${row['事件类型']}）受影响管段排查`,
      生成时间: formatTime(new Date()),
    })
  }
  if (added.length) {
    saveRows(CHECK_KEY, [...checks, ...added])
  }
}

/** 第三步：在缺陷记录上保留与应急事件的关联；已关联过的跳过 */
function linkDefects(id: number): void {
  const row = findEmergency(id)
  if (!row) {
    return
  }
  const defectCodes = splitCodes(row['关联缺陷'])
  if (!defectCodes.length) {
    return
  }
  const eventCode = String(row['事件编号'])
  let changed = false
  const next = listRows('defect').map((defect) => {
    if (
      defectCodes.includes(String(defect['缺陷编号'])) &&
      String(defect['关联应急事件'] ?? '') !== eventCode
    ) {
      changed = true
      return { ...defect, 关联应急事件: eventCode }
    }
    return defect
  })
  if (changed) {
    saveRows('defect', next)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 采纳升级建议：依次执行「推进状态 → 生成排查事项 → 保留关联缺陷」。
 * 每完成一步就把进度写回事件行，提交过程被打断时，重开页面可从断点继续，
 * 已生成的排查事项与缺陷关联不会重复产生。
 */
export async function acceptAdvice(id: number, stepDelay = 500): Promise<ActionResult> {
  const row = findEmergency(id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  let progress = progressOf(row)
  if (progress === '缺陷已关联') {
    return { ok: true, message: `事件 ${row['事件编号']} 的采纳流程此前已完成，无需重复提交` }
  }
  // 第一步：事件状态依次推进一级（不能跳级或回退，由 local-service 兜底校验）
  if (progress === '') {
    const next = nextActionOf(row)
    if (!next) {
      return { ok: false, message: '事件已到「已处置」，没有可推进的步骤' }
    }
    if (String(row.status) !== next.target) {
      const result = runAction('emergency', id, next.action)
      if (!result.ok) {
        return result
      }
    }
    updateEmergency(id, { 采纳进度: '状态已推进' })
    progress = '状态已推进'
    await delay(stepDelay)
  }
  // 第二步：排水管网生成受影响管段排查事项（幂等）
  if (progress === '状态已推进') {
    generateChecks(id)
    updateEmergency(id, { 采纳进度: '排查已生成' })
    progress = '排查已生成'
    await delay(stepDelay)
  }
  // 第三步：缺陷记录保留关联缺陷（幂等），并清空建议处理痕迹
  if (progress === '排查已生成') {
    linkDefects(id)
    updateEmergency(id, { 采纳进度: '缺陷已关联', 建议状态: '', 退回级别: 0 })
  }
  return {
    ok: true,
    message: `已采纳建议：事件 ${row['事件编号']} 状态推进完成，排查事项与关联缺陷均已落实`,
  }
}

/** 找出采纳流程被中断的事件（有进度标记但未走完），供页面重开时断点续传 */
export function findInterrupted(): { row: EntryRow; resumeStep: string }[] {
  return listRows('emergency')
    .filter((row) => {
      const progress = progressOf(row)
      return progress !== '' && progress !== '缺陷已关联'
    })
    .map((row) => ({ row, resumeStep: STEP_LABEL[progressOf(row)] }))
}

export function listChecks(): EntryRow[] {
  return listRows(CHECK_KEY)
}

/** 排查事项状态依次推进：待排查 → 排查中 → 已排查 */
export function advanceCheck(id: number): ActionResult {
  const checks = listRows(CHECK_KEY)
  const index = checks.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到该排查事项' }
  }
  const current = CHECK_FLOW.indexOf(String(checks[index].status) as (typeof CHECK_FLOW)[number])
  if (current < 0 || current >= CHECK_FLOW.length - 1) {
    return { ok: false, message: '该排查事项已完成，无需再推进' }
  }
  const target = CHECK_FLOW[current + 1]
  const next = [...checks]
  next[index] = { ...checks[index], status: target, pending: target !== '已排查' }
  saveRows(CHECK_KEY, next)
  return { ok: true, message: `排查事项已推进到「${target}」` }
}
