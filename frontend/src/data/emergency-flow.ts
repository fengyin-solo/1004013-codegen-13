/**
 * 应急事件处置时限升级：纯领域逻辑，不碰 localStorage，方便复用与测试。
 *
 * 完整链路：接报 → 启动响应 → 制定方案 → 确认处置。
 * - 接报在事件登记时自动完成，后三个节点只能依次推进，不能跳级或回退。
 * - 处置时限按危害等级取默认值（小时），也可人工补录；时限按比例拆到三个处置节点。
 * - 当前节点超过其节点时限时自动生成升级建议，操作员可采纳或退回。
 */
import type { EntryRow } from '@/data/types'

// 链路节点。index 0 是接报，登记即完成；1~3 对应三个可执行动作。
export const STEP_KEYS = ['report', 'respond', 'plan', 'resolve'] as const
export type StepKey = (typeof STEP_KEYS)[number]

export const STEP_LABELS: Record<StepKey, string> = {
  report: '接报',
  respond: '启动响应',
  plan: '制定方案',
  resolve: '确认处置',
}

// 每个节点对应的状态：链路节点下标即状态下标。
export const EMERGENCY_STATUSES = ['待响应', '响应中', '处置中', '已处置'] as const

// 节点动作：登记（接报）不走动作，其余一一对应。
export const STEP_ACTION: Partial<Record<StepKey, string>> = {
  respond: '启动响应',
  plan: '制定方案',
  resolve: '确认处置',
}

// 危害等级：一级最严重。默认处置时限（小时）与升级后的上报对象。
export const LEVEL_LIMIT_HOURS: Record<string, number> = {
  一级: 4,
  二级: 8,
  三级: 24,
  四级: 48,
}

export const LEVEL_ORDER = ['四级', '三级', '二级', '一级']

// 三个处置节点占用总时限的比例：启动响应 20%、制定方案 40%、确认处置累计 100%。
export const STEP_DEADLINE_RATIO: Record<Exclude<StepKey, 'report'>, number> = {
  respond: 0.2,
  plan: 0.4,
  resolve: 1,
}

// 升级后上报/知会的对象，等级越高上报层级越高。
export const ESCALATE_REPORT_TO: Record<string, string> = {
  一级: '市政府应急办、属地抢险指挥部',
  二级: '市城管局值班领导、排水管理处',
  三级: '排水管理处值班负责人',
  四级: '管网运营单位值班长',
}

export type DecisionStatus = 'accepted' | 'rejected'

export type StepState = {
  /** 节点完成时间（ISO），未完成为空；接报历史数据可能也为空。 */
  doneAt: string
  /** 制定方案节点填写的处置方案。 */
  plan?: string
}

export type EscalationAdvice = {
  /** 建议编号：EM-事件id-节点key，同一事件同一节点超时只产生一条。 */
  key: string
  eventId: number
  step: Exclude<StepKey, 'report'>
  /** 建议升级到的等级。 */
  level: string
  /** 节点时限（接报时间 + 分摊小时数），ISO。 */
  deadline: string
  overdueHours: number
  reportTo: string
  measure: string
  reason: string
  status: 'pending' | DecisionStatus
  decidedAt?: string
}

export type AcceptProgress = {
  /** 向导是否停在「确认生成」这一步（受影响管段已确认）。 */
  segmentsConfirmed: boolean
  segmentIds: number[]
  /** 已生成的排查事项编号，用于幂等。 */
  inspectionIds: number[]
  /** 已生成的关联缺陷编号，用于幂等。 */
  defectIds: number[]
}

export type TimelineEntry = {
  at: string
  step: StepKey
  label: string
  detail: string
}

export type EmergencyFlow = {
  eventId: number
  /** key 为节点 key；未出现的节点表示尚未完成。 */
  steps: Partial<Record<StepKey, StepState>>
  /** 历史上产生过的升级建议（含采纳/退回结论）。 */
  suggestions: EscalationAdvice[]
  /** 采纳后联动生成的提交进度，被打断重开时从这里恢复。 */
  accepts: Record<string, AcceptProgress>
  timeline: TimelineEntry[]
}

export type EmergencyFlowBundle = {
  flows: Record<number, EmergencyFlow>
}

/** 采纳升级建议后在排水管网页生成的受影响管段排查事项。 */
export type InspectionItem = {
  id: number
  itemNo: string
  eventId: number
  eventNo: string
  adviceKey: string
  segmentId: number
  segmentNo: string
  location: string
  content: string
  status: '待排查' | '排查中' | '已排查'
  createdAt: string
}

export const INSPECTION_STATUSES = ['待排查', '排查中', '已排查'] as const

export function normalizeLevel(raw: unknown): string {
  const text = String(raw ?? '').trim()
  return LEVEL_ORDER.includes(text) ? text : '四级'
}

/** 升一级；一级已是最高级，保持一级。 */
export function escalateLevel(level: string): string {
  const index = LEVEL_ORDER.indexOf(normalizeLevel(level))
  return LEVEL_ORDER[Math.min(index + 1, LEVEL_ORDER.length - 1)]
}

/** 处置时限（小时）：优先取人工补录/填写的数字，空或非法时按危害等级取默认值。 */
export function resolveLimitHours(row: EntryRow): number | null {
  const raw = String(row['处置时限'] ?? '').trim()
  if (raw === '' || raw.includes('样例')) {
    return null
  }
  const hours = Number(raw)
  return Number.isFinite(hours) && hours > 0 ? hours : LEVEL_LIMIT_HOURS[normalizeLevel(row['危害等级'])]
}

export function hasExplicitDeadline(row: EntryRow): boolean {
  const raw = String(row['处置时限'] ?? '').trim()
  if (raw === '' || raw.includes('样例')) {
    return false
  }
  return Number.isFinite(Number(raw)) && Number(raw) > 0
}

/** 接报时间转 Date；非法返回 null。 */
export function parseReportedAt(row: EntryRow): Date | null {
  const raw = String(row['接报时间'] ?? '').trim()
  if (!raw || raw.includes('样例')) {
    return null
  }
  const date = new Date(raw.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return '—'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/**
 * 某处置节点的时限点：接报时间 + 总时限 × 节点比例。
 * 比例 1 的确认处置直接取总时限，避免浮点误差。
 */
export function stepDeadline(
  reportedAt: Date,
  limitHours: number,
  step: Exclude<StepKey, 'report'>,
): Date {
  const ratio = STEP_DEADLINE_RATIO[step]
  return new Date(reportedAt.getTime() + limitHours * ratio * 3600_000)
}

/** 事件当前已完成到哪个节点（下标），状态下标即链路节点下标。 */
export function currentStepIndex(row: EntryRow): number {
  return Math.max(EMERGENCY_STATUSES.indexOf(String(row.status) as (typeof EMERGENCY_STATUSES)[number]), 0)
}

export function buildAdvice(
  row: EntryRow,
  step: Exclude<StepKey, 'report'>,
  deadline: Date,
  now: Date,
): EscalationAdvice {
  const level = escalateLevel(String(row['危害等级']))
  const reason = `「${STEP_LABELS[step]}」节点已超过处置时限（应于 ${formatDateTime(
    deadline.toISOString(),
  )} 前完成），危害等级${normalizeLevel(row['危害等级'])}，建议升级响应。`
  const measure =
    step === 'respond'
      ? '立即集结抢险班组、调度抽排与封堵设备赶赴现场，同步封闭作业区'
      : step === 'plan'
        ? '限期明确封堵、导改、抽排处置方案，通知管线权属单位到场会商'
        : '主要领导现场督办，按预案收尾并安排复查，防止次生溢流'
  return {
    key: `EM-${row.id}-${step}`,
    eventId: Number(row.id),
    step,
    level,
    deadline: deadline.toISOString(),
    overdueHours: Math.max(1, Math.round((now.getTime() - deadline.getTime()) / 3600_000)),
    reportTo: ESCALATE_REPORT_TO[level],
    measure,
    reason,
    status: 'pending',
  }
}

/**
 * 按当前时间、时限、进度计算「此刻应当存在」的超时建议。
 * 只针对当前待推进的那一个节点：已完成的节点不再翻旧账，未轮到的节点不提前催。
 * 没有处置时限或接报时间（历史数据）时不生成建议，交给页面提示补录。
 */
export function expectedAdvice(row: EntryRow, flow: EmergencyFlow, now: Date): EscalationAdvice | null {
  if (currentStepIndex(row) >= STEP_KEYS.length - 1) {
    return null
  }
  const step = STEP_KEYS[currentStepIndex(row) + 1] as Exclude<StepKey, 'report'>
  if (flow.steps[step]?.doneAt) {
    return null
  }
  const limitHours = resolveLimitHours(row)
  const reportedAt = parseReportedAt(row)
  if (limitHours === null || !reportedAt) {
    return null
  }
  const deadline = stepDeadline(reportedAt, limitHours, step)
  if (now.getTime() <= deadline.getTime()) {
    return null
  }
  return buildAdvice(row, step, deadline, now)
}

/**
 * 对账：保留已采纳/已退回的历史结论；待处理建议若节点已完成、补录时限后不再超时，
 * 就清掉（同节点再次超时会用同一 key 重新生成）。
 */
export function reconcileAdvice(
  existing: EscalationAdvice[],
  expected: EscalationAdvice | null,
): EscalationAdvice[] {
  const live = new Map(existing.map((item) => [item.key, item]))
  const decided = existing.filter((item) => item.status !== 'pending')
  if (expected) {
    const old = live.get(expected.key)
    live.set(expected.key, old && old.status !== 'pending' ? old : expected)
  }
  return [...decided, ...[...live.values()].filter((item) => item.status === 'pending')]
}

export function createFlow(eventId: number, reportedAt: string): EmergencyFlow {
  return {
    eventId,
    steps: { report: { doneAt: reportedAt } },
    suggestions: [],
    accepts: {},
    timeline: [
      {
        at: reportedAt || new Date().toISOString(),
        step: 'report',
        label: '接报',
        detail: '应急事件接报登记',
      },
    ],
  }
}

export const FLOW_STORAGE_KEY = 'underground-pipeline-inspection:emergency-flow'
