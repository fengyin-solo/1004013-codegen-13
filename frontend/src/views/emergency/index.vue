<template>
  <section class="page" data-module="emergency">
    <header class="page-head">
      <div>
        <h2>应急事件管理</h2>
        <p class="page-desc">
          接报 → 启动响应 → 制定方案 → 确认处置 全链路管控，状态只能依次推进；按处置时限与危害等级自动生成升级建议。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应急事件</button>
        <button class="btn" type="button" @click="exportRows">导出应急事件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ alert: item.label.includes('超时') }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>处置链路</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="view in views" :key="String(view.row.id)" :class="{ 'row-alert': view.advice }">
          <td v-for="column in columns" :key="column">{{ displayValue(view, column) }}</td>
          <td>
            <div class="chain-mini">
              <span
                v-for="(step, stepIndex) in chainSteps"
                :key="step.key"
                class="chain-dot"
                :class="dotClass(view, stepIndex)"
              >
                {{ step.label }}
              </span>
            </div>
            <span v-if="view.advice" class="tag tag-danger">超时升级建议待处理</span>
            <span v-else-if="view.deadlineMissing" class="tag tag-warn">缺处置时限·需补录</span>
            <span v-if="view.interruptedAccept" class="tag tag-info">采纳提交未完成</span>
          </td>
          <td>{{ view.row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(view)">处置链路</button>
          </td>
        </tr>
        <tr v-if="!filteredViews.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的应急事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredViews.length }} 条应急事件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记弹窗 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal">
        <h3>登记应急事件（接报）</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>事件类型 *</span>
            <input v-model="createForm.eventType" placeholder="如：污水管溢流" />
          </label>
          <label class="form-item">
            <span>事发地点 *</span>
            <input v-model="createForm.location" placeholder="如：滨河路与朝阳路口" />
          </label>
          <label class="form-item">
            <span>危害等级 *</span>
            <select v-model="createForm.level">
              <option v-for="level in levels" :key="level" :value="level">{{ level }}（时限 {{ levelLimits[level] }} 小时）</option>
            </select>
          </label>
          <label class="form-item">
            <span>接报时间 *</span>
            <input v-model="createForm.reportedAt" type="datetime-local" />
          </label>
          <label class="form-item">
            <span>处置时限（小时，可留空后补录）</span>
            <input v-model="createForm.limitHours" :placeholder="`默认 ${levelLimits[createForm.level]} 小时`" />
          </label>
          <label class="form-item">
            <span>接报人</span>
            <input v-model="createForm.reporter" placeholder="值班员姓名" />
          </label>
        </div>
        <p class="form-tip">登记即完成链路第一个节点「接报」，之后须依次启动响应、制定方案、确认处置。</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">确认接报</button>
        </div>
      </div>
    </div>

    <!-- 链路处置弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal modal-wide">
        <div class="modal-head">
          <h3>{{ detail.row['事件编号'] }} · {{ detail.row['事件类型'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </div>
        <p class="page-desc">{{ detail.row['事发地点'] }} · 危害等级{{ detail.row['危害等级'] }} · 接报时间 {{ formatDateTimeReported(detail.row) }}</p>

        <!-- 断点恢复提示 -->
        <div v-if="detail.interruptedAccept" class="banner banner-info">
          上次采纳升级建议的提交在「{{ detail.interruptedAccept.progress.segmentsConfirmed ? '生成排查事项与关联缺陷' : '确认受影响管段' }}」处被打断，
          已定位到尚未完成的步骤；已生成的事项不会重复生成。
          <button class="link" type="button" @click="resumeAccept(detail.interruptedAccept.adviceKey)">继续完成</button>
        </div>

        <!-- 链路步骤条 -->
        <ol class="chain-bar">
          <li
            v-for="(step, stepIndex) in chainSteps"
            :key="step.key"
            class="chain-node"
            :class="nodeClass(detail, stepIndex)"
          >
            <span class="node-index">{{ stepIndex + 1 }}</span>
            <div>
              <strong>{{ step.label }}</strong>
              <small>{{ stepTime(detail, stepIndex) }}</small>
            </div>
          </li>
        </ol>

        <!-- 当前节点动作 -->
        <div v-if="detail.activeStep" class="action-panel">
          <h4>当前节点：{{ stepLabel(detail.activeStep) }}</h4>
          <p class="deadline-line">
            节点时限：
            <template v-if="deadlineText(detail)">{{ deadlineText(detail) }}</template>
            <template v-else><span class="error-text">历史事件缺少处置时限，无法计算</span></template>
          </p>

          <div v-if="detail.activeStep === 'plan'" class="plan-editor">
            <textarea v-model="planText" rows="3" placeholder="填写处置方案：封堵、导改、抽排安排与责任分工"></textarea>
          </div>

          <div class="action-row">
            <button
              class="btn primary"
              type="button"
              :disabled="!!detail.advice || (detail.activeStep === 'plan' && !planText.trim())"
              @click="advance(detail, stepAction(detail.activeStep))"
            >
              {{ stepAction(detail.activeStep) }}
            </button>
            <button v-if="!hasExplicit(detail.row)" class="btn" type="button" @click="openBackfill(detail.row.id)">
              补录处置时限
            </button>
            <span v-if="detail.advice" class="form-tip">当前节点已超时，请先处理升级建议（采纳或退回）后再推进。</span>
          </div>
        </div>
        <div v-else class="banner banner-ok">该事件已确认处置，链路结束；状态不可回退。</div>

        <!-- 缺时限提示与补录 -->
        <div v-if="detail.deadlineMissing" class="banner banner-warn">
          该事件缺少处置时限（历史数据保留为空），无法自动判定超时与生成升级建议。补录后将立即重算。
          <button class="link" type="button" @click="openBackfill(detail.row.id)">补录处置时限</button>
        </div>

        <!-- 升级建议 -->
        <div v-if="detail.advice" class="advice-card">
          <h4>⚠️ 自动升级建议（超时 {{ detail.advice.overdueHours }} 小时）</h4>
          <p>{{ detail.advice.reason }}</p>
          <ul class="advice-list">
            <li>建议响应等级：{{ detail.row['危害等级'] }} → <strong>{{ detail.advice.level }}</strong></li>
            <li>上报 / 知会：{{ detail.advice.reportTo }}</li>
            <li>处置措施：{{ detail.advice.measure }}</li>
          </ul>
          <div class="action-row">
            <button class="btn primary" type="button" @click="openAccept(detail, detail.advice)">采纳并生成排查事项</button>
            <button class="btn" type="button" @click="openReject(detail, detail.advice)">退回建议</button>
          </div>
        </div>

        <!-- 建议处理结论（采纳/退回历史） -->
        <div v-if="decidedSuggestions.length" class="history-box">
          <h4>升级建议处理记录</h4>
          <ul>
            <li v-for="item in decidedSuggestions" :key="item.key">
              <span :class="item.status === 'accepted' ? 'tag tag-ok' : 'tag tag-muted'">
                {{ item.status === 'accepted' ? '已采纳' : '已退回' }}
              </span>
              {{ stepLabel(item.step) }} · 升级至 {{ item.level }} · {{ formatDateTime(item.decidedAt) }}
            </li>
          </ul>
        </div>

        <!-- 时间线 -->
        <div class="history-box">
          <h4>处置时间线</h4>
          <ol class="timeline">
            <li v-for="(entry, ti) in [...detail.flow.timeline].reverse()" :key="ti">
              <span class="timeline-time">{{ formatDateTime(entry.at) }}</span>
              <span class="timeline-label">{{ entry.label }}</span>
              <span class="timeline-detail">{{ entry.detail }}</span>
            </li>
          </ol>
        </div>
      </div>
    </div>

    <!-- 采纳向导弹窗 -->
    <div v-if="acceptState" class="modal-mask" @click.self="closeAccept">
      <div class="modal">
        <h3>采纳升级建议 · {{ acceptState.advice.key }}</h3>
        <ol class="wizard-steps">
          <li :class="{ active: acceptWizardStep === 0, done: acceptWizardStep > 0 }">1 勾选受影响管段</li>
          <li :class="{ active: acceptWizardStep === 1, done: acceptWizardStep > 1 }">2 确认生成</li>
        </ol>

        <!-- 步骤 1：勾选管段 -->
        <div v-if="acceptWizardStep === 0">
          <p class="form-tip">根据事发地点「{{ acceptState.view.row['事发地点'] }}」预选相关管段，可调整：</p>
          <table class="data-table pick-table">
            <thead>
              <tr><th></th><th>管段编号</th><th>上游节点</th><th>下游节点</th><th>运行状况</th></tr>
            </thead>
            <tbody>
              <tr v-for="segment in drainSegments" :key="segment.id">
                <td><input type="checkbox" :value="Number(segment.id)" v-model="selectedSegmentIds" /></td>
                <td>{{ segment['管段编号'] }}</td>
                <td>{{ segment['上游节点'] }}</td>
                <td>{{ segment['下游节点'] }}</td>
                <td>{{ segment['运行状况'] }}</td>
              </tr>
            </tbody>
          </table>
          <div class="modal-foot">
            <button class="btn ghost" type="button" @click="closeAccept">取消</button>
            <button class="btn primary" type="button" @click="confirmSegments">确认受影响管段</button>
          </div>
        </div>

        <!-- 步骤 2：生成事项与缺陷 -->
        <div v-else>
          <p class="form-tip">
            将为 {{ selectedSegmentIds.length }} 个管段生成受影响管段排查事项（排水管网页可查）与关联缺陷（缺陷记录页保留）。
            每个管段各 1 条，重复提交不会重复生成；若中途被打断，重开自动回到本步。
          </p>
          <div v-if="acceptResult" class="banner" :class="acceptResult.finished ? 'banner-ok' : 'banner-info'">
            {{ acceptResult.message }}
          </div>
          <div class="modal-foot">
            <button class="btn ghost" type="button" @click="acceptWizardStep = 0">返回修改管段</button>
            <button class="btn primary" type="button" :disabled="acceptResult?.finished" @click="generateArtifacts">
              {{ acceptResult?.finished ? '已生成，关闭即可' : '生成排查事项与关联缺陷' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 退回弹窗 -->
    <div v-if="rejectState" class="modal-mask" @click.self="rejectState = null">
      <div class="modal">
        <h3>退回升级建议 · {{ rejectState.advice.key }}</h3>
        <textarea v-model="rejectComment" rows="3" placeholder="退回理由（可选）：现场已在处置、时限误录等"></textarea>
        <p class="form-tip">退回后该节点本次超时不再提示；事件仍须依次推进，不能跳级。</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="rejectState = null">取消</button>
          <button class="btn primary" type="button" @click="confirmReject">确认退回</button>
        </div>
      </div>
    </div>

    <!-- 补录时限弹窗 -->
    <div v-if="backfillId !== null" class="modal-mask" @click.self="backfillId = null">
      <div class="modal">
        <h3>补录处置时限</h3>
        <label class="form-item">
          <span>处置时限（小时）</span>
          <input v-model="backfillHours" type="number" min="1" placeholder="如：8" />
        </label>
        <p class="form-tip">保存后按新时限重算节点时限与升级建议；历史结论（已采纳/退回）保留。</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="backfillId = null">取消</button>
          <button class="btn primary" type="button" @click="submitBackfill">保存并重算</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  acceptAdvice,
  advanceEmergency,
  backfillDeadline,
  confirmAdviceSegments,
  createEmergency,
  generateAdviceArtifacts,
  listEmergencyViews,
  rejectAdvice,
} from '@/api/emergency-service'
import { downloadEntries } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import {
  LEVEL_LIMIT_HOURS,
  LEVEL_ORDER,
  STEP_KEYS,
  STEP_LABELS,
  STEP_ACTION,
  formatDateTime,
  parseReportedAt,
  resolveLimitHours,
  stepDeadline,
} from '@/data/emergency-flow'
import type { EmergencyView } from '@/api/emergency-service'
import type { EntryRow } from '@/data/types'
import type { EscalationAdvice, StepKey } from '@/data/emergency-flow'

const columns = ['事件编号', '事件类型', '事发地点', '危害等级', '接报时间', '处置时限', '处置方案']
const filterFields = ['事件编号', '事件类型', '事发地点']
const levels = LEVEL_ORDER.slice().reverse()
const levelLimits = LEVEL_LIMIT_HOURS
const chainSteps = STEP_KEYS.map((key) => ({ key, label: STEP_LABELS[key] }))

const views = ref<EmergencyView[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const creating = ref(false)
const detail = ref<EmergencyView | null>(null)
const planText = ref('')
const backfillId = ref<number | null>(null)
const backfillHours = ref('')

const acceptState = ref<{ view: EmergencyView; advice: EscalationAdvice } | null>(null)
const acceptWizardStep = ref(0)
const selectedSegmentIds = ref<number[]>([])
const acceptResult = ref<{ message: string; finished: boolean } | null>(null)

const rejectState = ref<{ view: EmergencyView; advice: EscalationAdvice } | null>(null)
const rejectComment = ref('')

const createForm = ref({
  eventType: '',
  location: '',
  level: '三级',
  reportedAt: '',
  limitHours: '',
  reporter: '',
})

const drainSegments = ref<EntryRow[]>([])

const filteredViews = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  if (!pairs.length) {
    return views.value
  }
  return views.value.filter((view) =>
    pairs.every(([field, value]) => String(view.row[field] ?? '').includes(value.trim())),
  )
})

const stats = computed(() => [
  { label: '待响应事件', value: views.value.filter((v) => v.row.status === '待响应').length },
  { label: '处置中事件', value: views.value.filter((v) => v.row.status === '响应中' || v.row.status === '处置中').length },
  { label: '已处置事件', value: views.value.filter((v) => v.row.status === '已处置').length },
  { label: '超时待处理建议', value: views.value.filter((v) => v.advice).length },
])

const statusSummary = computed(() =>
  ['待响应', '响应中', '处置中', '已处置'].map((status) => ({
    status,
    count: views.value.filter((view) => view.row.status === status).length,
  })),
)

const decidedSuggestions = computed(() =>
  detail.value ? detail.value.flow.suggestions.filter((item) => item.status !== 'pending') : [],
)

function stepLabel(step: StepKey): string {
  return STEP_LABELS[step]
}
function stepAction(step: Exclude<StepKey, 'report'>): string {
  return STEP_ACTION[step] as string
}
function hasExplicit(row: EntryRow): boolean {
  const raw = String(row['处置时限'] ?? '').trim()
  return raw !== '' && !raw.includes('样例') && Number(raw) > 0
}

function displayValue(view: EmergencyView, column: string): string {
  if (column === '接报时间') {
    return formatDateTimeReported(view.row)
  }
  if (column === '处置时限') {
    return hasExplicit(view.row) ? `${view.row['处置时限']} 小时` : '—（待补录）'
  }
  return String(view.row[column] ?? '—')
}

function formatDateTimeReported(row: EntryRow): string {
  const date = parseReportedAt(row)
  return date ? formatDateTime(date.toISOString()) : '—'
}

function dotClass(view: EmergencyView, stepIndex: number): string {
  const statusIndex = ['待响应', '响应中', '处置中', '已处置'].indexOf(view.row.status)
  if (stepIndex < statusIndex) return 'done'
  if (stepIndex === statusIndex) return 'doing'
  return 'todo'
}

function nodeClass(view: EmergencyView, stepIndex: number): string {
  const statusIndex = ['待响应', '响应中', '处置中', '已处置'].indexOf(view.row.status)
  if (stepIndex < statusIndex) return 'done'
  if (stepIndex === statusIndex) return 'doing'
  return 'todo'
}

function stepTime(view: EmergencyView, stepIndex: number): string {
  const key = STEP_KEYS[stepIndex]
  const state = view.flow.steps[key]
  if (state?.doneAt) {
    return formatDateTime(state.doneAt)
  }
  if (stepIndex <= ['待响应', '响应中', '处置中', '已处置'].indexOf(view.row.status)) {
    return '历史节点（时间未记录）'
  }
  return '未开始'
}

function deadlineText(view: EmergencyView): string {
  const limit = resolveLimitHours(view.row)
  const reported = parseReportedAt(view.row)
  if (limit === null || !reported || !view.activeStep) {
    return ''
  }
  const deadline = stepDeadline(reported, limit, view.activeStep)
  const overdue = Date.now() > deadline.getTime()
  return `${formatDateTime(deadline.toISOString())}${overdue ? '（已超时）' : ''}`
}

function openCreate() {
  createForm.value = {
    eventType: '',
    location: '',
    level: '三级',
    reportedAt: '',
    limitHours: '',
    reporter: '',
  }
  creating.value = true
}

function submitCreate() {
  const result = createEmergency(createForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  creating.value = false
  reload()
}

function openDetail(view: EmergencyView) {
  detail.value = view
  planText.value = view.flow.steps.plan?.plan ?? String(view.row['处置方案'] ?? '')
}

function closeDetail() {
  detail.value = null
}

function advance(view: EmergencyView, action: string) {
  const result = advanceEmergency(Number(view.row.id), action, planText.value)
  errorMessage.value = result.ok ? '' : result.message
  if (!result.ok) {
    return
  }
  reload()
  const refreshed = views.value.find((item) => item.row.id === view.row.id) ?? null
  detail.value = refreshed
  if (refreshed) {
    planText.value = refreshed.flow.steps.plan?.plan ?? ''
  }
}

function openBackfill(id: number) {
  backfillId.value = id
  backfillHours.value = ''
}

function submitBackfill() {
  if (backfillId.value === null) return
  const result = backfillDeadline(backfillId.value, backfillHours.value)
  errorMessage.value = result.ok ? '' : result.message
  if (!result.ok) {
    return
  }
  backfillId.value = null
  reload()
  if (detail.value) {
    const id = detail.value.row.id
    detail.value = views.value.find((item) => item.row.id === id) ?? null
  }
}

function preselectSegments(view: EmergencyView) {
  const location = String(view.row['事发地点'] ?? '')
  const matched = drainSegments.value
    .filter((segment) =>
      [String(segment['上游节点']), String(segment['下游节点']), String(segment['管段编号'])].some((value) =>
        value.includes(location.slice(0, 2)),
      ),
    )
    .map((segment) => Number(segment.id))
  selectedSegmentIds.value = matched.length ? matched : drainSegments.value.slice(0, 2).map((s) => Number(s.id))
}

function openAccept(view: EmergencyView, advice: EscalationAdvice) {
  acceptState.value = { view, advice }
  acceptResult.value = null
  const progress = view.flow.accepts[advice.key]
  if (progress) {
    // 断点恢复：已确认过管段就直接落到第二步。
    selectedSegmentIds.value = [...progress.segmentIds]
    acceptWizardStep.value = progress.segmentsConfirmed ? 1 : 0
    if (progress.segmentsConfirmed && progress.inspectionIds.length > 0 && progress.defectIds.length > 0) {
      acceptResult.value = { message: '该建议的排查事项与关联缺陷已全部生成', finished: true }
    }
  } else {
    acceptWizardStep.value = 0
    preselectSegments(view)
  }
}

function resumeAccept(adviceKey: string) {
  if (!detail.value) return
  const advice = detail.value.flow.suggestions.find((item) => item.key === adviceKey)
  if (advice) {
    openAccept(detail.value, advice)
  }
}

function closeAccept() {
  acceptState.value = null
  reload()
  if (detail.value) {
    const id = detail.value.row.id
    detail.value = views.value.find((item) => item.row.id === id) ?? null
  }
}

function confirmSegments() {
  if (!acceptState.value) return
  const accept = acceptAdvice(
    Number(acceptState.value.view.row.id),
    acceptState.value.advice.key,
    selectedSegmentIds.value,
  )
  if (!accept.ok) {
    errorMessage.value = accept.message
    return
  }
  const confirmed = confirmAdviceSegments(
    Number(acceptState.value.view.row.id),
    acceptState.value.advice.key,
  )
  errorMessage.value = confirmed.ok ? '' : confirmed.message
  if (!confirmed.ok) {
    return
  }
  acceptWizardStep.value = 1
}

function generateArtifacts() {
  if (!acceptState.value) return
  const result = generateAdviceArtifacts(
    Number(acceptState.value.view.row.id),
    acceptState.value.advice.key,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  acceptResult.value = { message: result.message, finished: result.finished }
  reload()
}

function openReject(view: EmergencyView, advice: EscalationAdvice) {
  rejectState.value = { view, advice }
  rejectComment.value = ''
}

function confirmReject() {
  if (!rejectState.value) return
  const result = rejectAdvice(
    Number(rejectState.value.view.row.id),
    rejectState.value.advice.key,
    rejectComment.value,
  )
  errorMessage.value = result.ok ? '' : result.message
  if (!result.ok) {
    return
  }
  rejectState.value = null
  reload()
  if (detail.value) {
    const id = detail.value.row.id
    detail.value = views.value.find((item) => item.row.id === id) ?? null
  }
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries('emergency')
}

// 触发列表读取以保证类型一致（实际列表走应急服务的视图）。

function reload() {
  errorMessage.value = ''
  try {
    views.value = listEmergencyViews()
    drainSegments.value = listRows('drain_network')
    if (detail.value) {
      const id = detail.value.row.id
      detail.value = views.value.find((item) => item.row.id === id) ?? detail.value
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应急事件列表读取失败'
  }
}

onMounted(reload)
</script>
