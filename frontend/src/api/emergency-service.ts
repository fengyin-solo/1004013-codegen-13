/**
 * 应急事件处置时限升级的业务服务：页面只做渲染和表单收集，所有判断都在这里。
 *
 * 数据流：
 * - 应急事件本身仍是 emergency 模块的一条 EntryRow（接报时间/危害等级/处置时限/处置方案/状态）。
 * - 流程态（节点完成时间、升级建议、采纳向导进度、时间线）存独立的 emergency-flow 键。
 * - 采纳后：受影响管段排查事项存独立键；关联缺陷直接写进 defect 模块（缺陷记录页可见）。
 */
import { listRows, readJson, saveRows, writeJson } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { EMERGENCY_FLOW_SEED, EMERGENCY_INSPECTION_SEED } from '@/data/emergency-flow-seed'
import {
  EMERGENCY_STATUSES,
  FLOW_STORAGE_KEY,
  STEP_ACTION,
  STEP_KEYS,
  STEP_LABELS,
  createFlow,
  currentStepIndex,
  escalateLevel,
  expectedAdvice,
  formatDateTime,
  hasExplicitDeadline,
  normalizeLevel,
  reconcileAdvice,
} from '@/data/emergency-flow'
import type {
  AcceptProgress,
  EmergencyFlow,
  EmergencyFlowBundle,
  EscalationAdvice,
  InspectionItem,
  StepKey,
} from '@/data/emergency-flow'

const EMERGENCY_KEY = 'emergency'
const INSPECTION_STORAGE_KEY = 'underground-pipeline-inspection:emergency-inspections'

function loadBundle(): EmergencyFlowBundle {
  const bundle = readJson<EmergencyFlowBundle>(FLOW_STORAGE_KEY, EMERGENCY_FLOW_SEED)
  bundle.flows = bundle.flows ?? {}
  return bundle
}

function saveBundle(bundle: EmergencyFlowBundle): void {
  writeJson(FLOW_STORAGE_KEY, bundle)
}

/** 为历史事件补一个最小流程：接报节点按行上的接报时间标记，拿不到就留空。 */
function ensureFlow(bundle: EmergencyFlowBundle, row: EntryRow): EmergencyFlow {
  const existing = bundle.flows[Number(row.id)]
  if (existing) {
    existing.steps = existing.steps ?? {}
    existing.suggestions = existing.suggestions ?? []
    existing.accepts = existing.accepts ?? {}
    existing.timeline = existing.timeline ?? []
    return existing
  }
  const reportedAt = String(row['接报时间'] ?? '').trim()
  const iso = reportedAt && !reportedAt.includes('样例')
    ? new Date(reportedAt.replace(' ', 'T')).toISOString()
    : ''
  const flow = createFlow(Number(row.id), iso)
  // 历史事件已经走到后面状态时，历史节点没有真实完成时间，标记为已完成但时间留空。
  const index = currentStepIndex(row)
  STEP_KEYS.slice(1, index + 1).forEach((step) => {
    flow.steps[step] = { doneAt: '' }
  })
  bundle.flows[Number(row.id)] = flow
  return flow
}

function loadInspections(): InspectionItem[] {
  const items = readJson<InspectionItem[]>(INSPECTION_STORAGE_KEY, EMERGENCY_INSPECTION_SEED)
  return Array.isArray(items) ? items : []
}

function saveInspections(items: InspectionItem[]): void {
  writeJson(INSPECTION_STORAGE_KEY, items)
}

function persistEmergency(rows: EntryRow[]): void {
  saveRows(EMERGENCY_KEY, rows)
}

export type EmergencyView = {
  row: EntryRow
  flow: EmergencyFlow
  /** 当前待推进节点（已处置时为 null）。 */
  activeStep: Exclude<StepKey, 'report'> | null
  /** 此刻生效的升级建议（无时限/未超时为 null）。 */
  advice: EscalationAdvice | null
  /** 采纳向导是否有未走完的提交（被打断后重开要定位到这里）。 */
  interruptedAccept: { adviceKey: string; progress: AcceptProgress } | null
  deadlineMissing: boolean
}

function viewOf(row: EntryRow, flow: EmergencyFlow, now: Date): EmergencyView {
  const adviceModel = expectedAdvice(row, flow, now)
  const advice = adviceModel
    ? flow.suggestions.find((item) => item.key === adviceModel.key && item.status === 'pending') ??
      null
    : null
  const index = currentStepIndex(row)
  const activeStep =
    index < STEP_KEYS.length - 1 ? (STEP_KEYS[index + 1] as Exclude<StepKey, 'report'>) : null
  const interruptedEntry = Object.entries(flow.accepts).find(([, progress]) => {
    if (!progress.segmentsConfirmed) {
      return true
    }
    return progress.inspectionIds.length === 0 || progress.defectIds.length === 0
  })
  return {
    row,
    flow,
    activeStep,
    advice,
    interruptedAccept: interruptedEntry
      ? { adviceKey: interruptedEntry[0], progress: interruptedEntry[1] }
      : null,
    deadlineMissing: !hasExplicitDeadline(row),
  }
}

/** 列表读取：顺带把每个事件的流程态与当前升级建议对账好。 */
export function listEmergencyViews(): EmergencyView[] {
  const rows = listRows(EMERGENCY_KEY)
  const bundle = loadBundle()
  const now = new Date()
  let changed = false
  const views = rows.map((row) => {
    const flow = ensureFlow(bundle, row)
    const expected = expectedAdvice(row, flow, now)
    const before = flow.suggestions.map((item) => `${item.key}:${item.status}`).join('|')
    flow.suggestions = reconcileAdvice(flow.suggestions, expected)
    const after = flow.suggestions.map((item) => `${item.key}:${item.status}`).join('|')
    if (before !== after) {
      changed = true
    }
    return viewOf(row, flow, now)
  })
  if (changed) {
    saveBundle(bundle)
  }
  return views
}

export function getEmergencyView(id: number): EmergencyView | null {
  return listEmergencyViews().find((view) => Number(view.row.id) === id) ?? null
}

function nextEventNo(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const match = String(row['事件编号'] ?? '').match(/(\d+)$/)
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `EMER-${String(max + 1).padStart(4, '0')}`
}

export type CreateEmergencyInput = {
  eventType: string
  location: string
  level: string
  reportedAt: string
  /** 处置时限（小时），历史补录场景外一般登记时就填；允许空。 */
  limitHours: string
  reporter: string
}

/** 登记即完成「接报」节点。 */
export function createEmergency(input: CreateEmergencyInput): ActionResult {
  if (!input.eventType.trim() || !input.location.trim()) {
    return { ok: false, message: '事件类型和事发地点不能为空' }
  }
  if (!input.reportedAt) {
    return { ok: false, message: '请填写接报时间' }
  }
  const hours = input.limitHours.trim()
  if (hours && (!(Number(hours) > 0) || !Number.isFinite(Number(hours)))) {
    return { ok: false, message: '处置时限需为大于 0 的小时数' }
  }
  const rows = listRows(EMERGENCY_KEY)
  const bundle = loadBundle()
  const now = new Date()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const iso = new Date(input.reportedAt).toISOString()
  const row: EntryRow = {
    id,
    status: EMERGENCY_STATUSES[0],
    pending: true,
    abnormal: false,
    事件编号: nextEventNo(rows),
    事件类型: input.eventType.trim(),
    事发地点: input.location.trim(),
    危害等级: normalizeLevel(input.level),
    接报时间: input.reportedAt,
    处置时限: hours,
    上报对象: '',
    接报人: input.reporter.trim(),
    处置方案: '',
  }
  const flow = createFlow(id, iso)
  flow.timeline[0].detail = `接报人 ${input.reporter.trim() || '值班员'} 登记事件`
  bundle.flows[id] = flow
  persistEmergency([...rows, row])
  saveBundle(bundle)
  void now
  return { ok: true, message: `应急事件 ${row['事件编号']} 已接报登记，请依次启动响应` }
}

/**
 * 链路推进：只允许当前节点的动作，状态必须依次走。
 * - 跳级：动作不是当前节点的动作 → 拒绝
 * - 回退：目标状态不在当前状态之后 → 拒绝
 */
export function advanceEmergency(
  id: number,
  action: string,
  planText = '',
): ActionResult {
  const rows = listRows(EMERGENCY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  const row = rows[index]
  const current = currentStepIndex(row)
  if (current >= STEP_KEYS.length - 1) {
    return { ok: false, message: '事件已确认处置，链路已结束，不能再推进或回退' }
  }
  const nextStep = STEP_KEYS[current + 1] as Exclude<StepKey, 'report'>
  if (STEP_ACTION[nextStep] !== action) {
    return {
      ok: false,
      message: `当前必须先完成「${STEP_LABELS[nextStep]}」，不能跳到「${action}」，事件状态不允许跳级或回退`,
    }
  }
  if (nextStep === 'plan' && !planText.trim()) {
    return { ok: false, message: '制定方案需要填写处置方案内容' }
  }

  const bundle = loadBundle()
  const flow = ensureFlow(bundle, row)
  const nowIso = new Date().toISOString()
  const targetStatus = EMERGENCY_STATUSES[current + 1]

  flow.steps[nextStep] = {
    doneAt: nowIso,
    ...(nextStep === 'plan' ? { plan: planText.trim() } : {}),
  }
  flow.timeline.push({
    at: nowIso,
    step: nextStep,
    label: STEP_LABELS[nextStep],
    detail: nextStep === 'plan' ? `处置方案：${planText.trim()}` : `执行「${action}」`,
  })
  // 节点完成后，针对该节点的待处理升级建议自动失效（已采纳/退回的结论保留）。
  flow.suggestions = reconcileAdvice(flow.suggestions, expectedAdvice(row, flow, new Date()))

  const updated: EntryRow = {
    ...row,
    status: targetStatus,
    pending: targetStatus !== EMERGENCY_STATUSES[EMERGENCY_STATUSES.length - 1],
    ...(nextStep === 'plan' ? { 处置方案: planText.trim() } : {}),
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  persistEmergency(nextRows)
  saveBundle(bundle)
  return { ok: true, message: `已完成「${STEP_LABELS[nextStep]}」，事件状态推进为「${targetStatus}」` }
}

/** 补录处置时限（小时）后立即重算升级建议。历史事件缺时限时这里是空，允许留空查看。 */
export function backfillDeadline(id: number, hoursText: string): ActionResult {
  const rows = listRows(EMERGENCY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  const hours = Number(hoursText)
  if (!(hours > 0) || !Number.isFinite(hours)) {
    return { ok: false, message: '处置时限需为大于 0 的小时数' }
  }
  const bundle = loadBundle()
  const flow = ensureFlow(bundle, rows[index])
  const nowIso = new Date().toISOString()
  const updated: EntryRow = { ...rows[index], 处置时限: String(hours) }
  flow.timeline.push({
    at: nowIso,
    step: STEP_KEYS[currentStepIndex(updated)] ?? 'report',
    label: '补录处置时限',
    detail: `补录处置时限 ${hours} 小时，已按新时限重算升级建议`,
  })
  flow.suggestions = reconcileAdvice(flow.suggestions, expectedAdvice(updated, flow, new Date()))
  const nextRows = [...rows]
  nextRows[index] = updated
  persistEmergency(nextRows)
  saveBundle(bundle)
  const view = getEmergencyView(id)
  if (view?.advice) {
    return { ok: true, message: `已补录并重新计算：${view.advice.reason}` }
  }
  return { ok: true, message: '已补录处置时限并重新计算，当前节点未超时，暂无升级建议' }
}

/** 退回建议：同节点同一次超时不再提示；结论留在时间线/建议记录里。 */
export function rejectAdvice(id: number, adviceKey: string, comment: string): ActionResult {
  const rows = listRows(EMERGENCY_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  const bundle = loadBundle()
  const flow = ensureFlow(bundle, row)
  const target = flow.suggestions.find((item) => item.key === adviceKey)
  if (!target || target.status !== 'pending') {
    return { ok: false, message: '该升级建议已处理，不能重复退回' }
  }
  target.status = 'rejected'
  target.decidedAt = new Date().toISOString()
  flow.timeline.push({
    at: target.decidedAt,
    step: target.step,
    label: '退回升级建议',
    detail: `不采纳升级到${target.level}的建议${comment.trim() ? `；理由：${comment.trim()}` : ''}`,
  })
  persistEmergency(rows)
  saveBundle(bundle)
  return { ok: true, message: '已退回升级建议，事件仍须依次推进当前节点' }
}

/** 采纳第一步：记录采纳结论、升级事件等级与上报对象，并建立可恢复的向导进度。 */
export function acceptAdvice(
  id: number,
  adviceKey: string,
  segmentIds: number[],
): ActionResult & { progress?: AcceptProgress } {
  const rows = listRows(EMERGENCY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件` }
  }
  const row = rows[index]
  const bundle = loadBundle()
  const flow = ensureFlow(bundle, row)
  const advice = flow.suggestions.find((item) => item.key === adviceKey)
  if (!advice || advice.status !== 'pending') {
    return { ok: false, message: '该升级建议已处理，不能重复采纳' }
  }
  if (segmentIds.length === 0) {
    return { ok: false, message: '请至少勾选一个受影响管段' }
  }
  const nowIso = new Date().toISOString()
  advice.status = 'accepted'
  advice.decidedAt = nowIso

  const progress: AcceptProgress = flow.accepts[adviceKey] ?? {
    segmentsConfirmed: false,
    segmentIds: [],
    inspectionIds: [],
    defectIds: [],
  }
  // 允许重新勾选，但已经生成过的事项/缺陷不会因为重选而重复生成。
  progress.segmentIds = segmentIds
  flow.accepts[adviceKey] = progress

  flow.timeline.push({
    at: nowIso,
    step: advice.step,
    label: '采纳升级建议',
    detail: `响应升级为${advice.level}，上报${advice.reportTo}，开始排查 ${segmentIds.length} 个受影响管段`,
  })

  const updated: EntryRow = {
    ...row,
    危害等级: advice.level,
    上报对象: advice.reportTo,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  persistEmergency(nextRows)
  saveBundle(bundle)
  return { ok: true, message: '已采纳升级建议，请确认受影响管段并生成排查事项', progress }
}

/** 采纳第二步：确认受影响管段勾选结果。 */
export function confirmAdviceSegments(id: number, adviceKey: string): ActionResult {
  const bundle = loadBundle()
  const flow = bundle.flows[id]
  const progress = flow?.accepts[adviceKey]
  if (!progress) {
    return { ok: false, message: '请先采纳升级建议并勾选受影响管段' }
  }
  if (progress.segmentIds.length === 0) {
    return { ok: false, message: '请至少勾选一个受影响管段' }
  }
  progress.segmentsConfirmed = true
  saveBundle(bundle)
  return { ok: true, message: '受影响管段已确认，下一步生成排查事项与关联缺陷' }
}

/**
 * 采纳第三步（可整体提交，也可分步提交，断点保存）：
 * 为每个勾选管段生成一条排查事项 + 一条关联缺陷；已生成的编号在进度里，绝不重复。
 */
export function generateAdviceArtifacts(
  id: number,
  adviceKey: string,
): ActionResult & { inspectionAdded: number; defectAdded: number; finished: boolean } {
  const rows = listRows(EMERGENCY_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的应急事件`, inspectionAdded: 0, defectAdded: 0, finished: false }
  }
  const bundle = loadBundle()
  const flow = bundle.flows[id]
  const progress = flow?.accepts[adviceKey]
  if (!progress || !progress.segmentsConfirmed) {
    return { ok: false, message: '请先确认受影响管段', inspectionAdded: 0, defectAdded: 0, finished: false }
  }
  const advice = flow.suggestions.find((item) => item.key === adviceKey)

  const segments = listRows('drain_network')
  const selected = segments.filter((segment) => progress.segmentIds.includes(Number(segment.id)))
  const inspections = loadInspections()
  const defects = listRows('defect')

  let inspectionSeq = inspections.reduce((max, item) => Math.max(max, item.id), 0)
  let defectRowSeq = defects.reduce((max, item) => Math.max(max, Number(item.id)), 0)
  const defectNoMax = defects.reduce((max, item) => {
    const match = String(item['缺陷编号'] ?? '').match(/(\d+)$/)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  let defectNoSeq = defectNoMax
  const nowIso = new Date().toISOString()
  const today = formatDateTime(nowIso).slice(0, 10)
  let inspectionAdded = 0
  let defectAdded = 0

  selected.forEach((segment) => {
    const segmentId = Number(segment.id)
    const segmentNo = String(segment['管段编号'] ?? `管段-${segmentId}`)
    const existsInspection = inspections.some(
      (item) => item.adviceKey === adviceKey && item.segmentId === segmentId,
    )
    if (!existsInspection) {
      inspectionSeq += 1
      inspections.push({
        id: inspectionSeq,
        itemNo: `PAT-${String(inspectionSeq).padStart(4, '0')}`,
        eventId: id,
        eventNo: String(row['事件编号'] ?? ''),
        adviceKey,
        segmentId,
        segmentNo,
        location: String(segment['上游节点'] ?? '') + '—' + String(segment['下游节点'] ?? ''),
        content: `${advice?.measure ?? '升级响应处置'}：排查 ${segmentNo} 水位、淤积与溢流情况，落实封堵导改`,
        status: '待排查',
        createdAt: nowIso,
      })
      progress.inspectionIds.push(inspectionSeq)
      inspectionAdded += 1
    }

    const existsDefect = defects.some(
      (item) =>
        String(item['关联应急事件'] ?? '') === String(row['事件编号'] ?? '') &&
        String(item['关联管段'] ?? '') === segmentNo,
    )
    if (!existsDefect) {
      defectRowSeq += 1
      defectNoSeq += 1
      defects.push({
        id: defectRowSeq,
        status: '待确认',
        pending: true,
        abnormal: false,
        缺陷编号: `DEFE-${String(defectNoSeq).padStart(4, '0')}`,
        所属管线: segmentNo,
        缺陷类型: '应急排查缺陷',
        发现位置: String(row['事发地点'] ?? ''),
        严重等级: escalateLevel(String(row['危害等级'])),
        发现日期: today,
        缺陷描述: `应急事件 ${row['事件编号']} 采纳升级建议后生成，需现场核查 ${segmentNo} 是否存在破损、淤堵或倒灌`,
        记录状态: '应急待核',
        关联应急事件: String(row['事件编号'] ?? ''),
        关联管段: segmentNo,
      })
      progress.defectIds.push(defectRowSeq)
      defectAdded += 1
    }
  })

  saveInspections(inspections)
  saveRows('defect', defects)
  const finished = progress.inspectionIds.length > 0 && progress.defectIds.length > 0
  if (finished) {
    flow.timeline.push({
      at: nowIso,
      step: advice?.step ?? 'respond',
      label: '生成排查事项',
      detail: `生成受影响管段排查事项 ${progress.inspectionIds.length} 条、关联缺陷 ${progress.defectIds.length} 条`,
    })
  }
  saveBundle(bundle)
  return {
    ok: true,
    message: finished
      ? `已生成排查事项 ${progress.inspectionIds.length} 条、关联缺陷 ${progress.defectIds.length} 条`
      : '部分事项已提交，请继续完成剩余步骤',
    inspectionAdded,
    defectAdded,
    finished,
  }
}

/** 排水管网页：受影响管段排查事项。 */
export function listInspections(): InspectionItem[] {
  return loadInspections()
}

export function updateInspectionStatus(id: number, status: InspectionItem['status']): ActionResult {
  const items = loadInspections()
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) {
    return { ok: false, message: '没有找到该排查事项' }
  }
  items[index] = { ...items[index], status }
  saveInspections(items)
  return { ok: true, message: `排查事项已更新为「${status}」` }
}

/** 缺陷记录页：应急联动生成的关联缺陷。 */
export function listLinkedDefects(eventNo?: string): EntryRow[] {
  return listRows('defect').filter((row) => {
    const linked = String(row['关联应急事件'] ?? '') !== ''
    return linked && (eventNo ? String(row['关联应急事件']) === eventNo : true)
  })
}
