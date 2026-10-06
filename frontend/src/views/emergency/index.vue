<template>
  <section class="page" data-module="emergency">
    <header class="page-head">
      <div>
        <h2>应急事件管理</h2>
        <p class="page-desc">维护应急事件，按接报→启动响应→制定方案→确认处置链路依次推进，依据处置时限与危害等级自动生成升级建议。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应急事件</button>
        <button class="btn" type="button" @click="exportRows">导出应急事件清单</button>
      </div>
    </header>

    <div class="chain-bar">
      <span class="chain-title">处置链路</span>
      <template v-for="(step, index) in chainSteps" :key="step">
        <span class="chain-step">{{ index + 1 }}. {{ step }}</span>
        <span v-if="index < chainSteps.length - 1" class="chain-arrow">→</span>
      </template>
      <span class="chain-note">事件状态依次推进，不能跳级或回退</span>
    </div>

    <p v-if="resumeMessage" class="resume-tip">{{ resumeMessage }}</p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
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
          <th>升级建议</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '处置时限'">{{ deadlineText(row) || '—' }}</template>
            <template v-else>{{ cellText(row, column) }}</template>
          </td>
          <td>
            <div v-if="adviceOf(row)" class="advice-cell">
              <span class="advice-tag" :class="`level-${adviceOf(row)!.level}`">
                {{ adviceOf(row)!.levelLabel }}
              </span>
              <span>{{ adviceOf(row)!.text }}</span>
              <span class="advice-actions">
                <button
                  class="link"
                  type="button"
                  :disabled="acceptingId === Number(row.id)"
                  @click="accept(row)"
                >
                  {{ acceptingId === Number(row.id) ? '采纳中…' : '采纳' }}
                </button>
                <button class="link" type="button" @click="reject(row)">退回</button>
              </span>
            </div>
            <span v-else-if="isRejected(row)" class="muted-text">建议已退回</span>
            <span v-else>—</span>
          </td>
          <td>
            {{ row.status }}
            <div class="chain-mini">{{ chainProgress(row) }}</div>
          </td>
          <td class="row-actions">
            <button
              v-if="nextAction(row)"
              class="link"
              type="button"
              @click="runAction(nextAction(row), row)"
            >
              {{ nextAction(row) }}
            </button>
            <button
              v-if="needDeadline(row)"
              class="link"
              type="button"
              @click="openDeadlineEditor(row)"
            >
              补录时限
            </button>
            <span v-if="!nextAction(row) && !needDeadline(row)">—</span>
            <div v-if="deadlineEditingId === Number(row.id)" class="deadline-editor">
              <input
                v-model="deadlineInput"
                type="number"
                min="1"
                step="1"
                placeholder="小时数"
              />
              <button class="link" type="button" @click="saveDeadline(row)">保存</button>
              <button class="link" type="button" @click="cancelDeadline">取消</button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无应急事件数据，可先登记应急事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急事件记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CHAIN_STEPS,
  acceptAdvice,
  buildAdvice,
  findInterrupted,
  nextActionOf,
  parseHours,
  rejectAdvice,
  supplementDeadline,
  type Advice,
} from '@/api/emergency-flow'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('emergency')
const columns = ["事件编号", "事件类型", "事发地点", "危害等级", "接报时间", "处置时限", "处置方案", "受影响管段", "关联缺陷", "事件状态"]
const statuses = ["待响应", "响应中", "处置中", "已处置"]
const stats = [{"label": "待响应事件", "value": 0}, {"label": "处置中事件", "value": 0}, {"label": "已处置事件", "value": 0}]

const chainSteps = CHAIN_STEPS
const chainShort = ['接报', '响应', '方案', '处置']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const resumeMessage = ref('')
const acceptingId = ref<number | null>(null)
const deadlineEditingId = ref<number | null>(null)
const deadlineInput = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function cellText(row: EntryRow, column: string): string {
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function deadlineText(row: EntryRow): string {
  const hours = parseHours(row['处置时限'])
  return hours === null ? '' : `${hours}小时`
}

function adviceOf(row: EntryRow): Advice | null {
  return buildAdvice(row)
}

function isRejected(row: EntryRow): boolean {
  return String(row['建议状态'] ?? '') === '已退回'
}

function nextAction(row: EntryRow): string {
  return nextActionOf(row)?.action ?? ''
}

function needDeadline(row: EntryRow): boolean {
  return parseHours(row['处置时限']) === null && String(row.status) !== '已处置'
}

function chainProgress(row: EntryRow): string {
  const index = statuses.indexOf(String(row.status))
  return chainShort.map((step, i) => (i <= index ? `${step}✓` : step)).join('→')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '应急事件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

async function accept(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  acceptingId.value = Number(row.id)
  try {
    const result = await acceptAdvice(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
    } else {
      noticeMessage.value = result.message
    }
  } finally {
    acceptingId.value = null
    reload()
  }
}

function reject(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = rejectAdvice(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function openDeadlineEditor(row: EntryRow) {
  deadlineEditingId.value = Number(row.id)
  deadlineInput.value = ''
}

function cancelDeadline() {
  deadlineEditingId.value = null
  deadlineInput.value = ''
}

function saveDeadline(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = supplementDeadline(Number(row.id), Number(deadlineInput.value))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  cancelDeadline()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应急事件列表读取失败'
  }
}

onMounted(async () => {
  reload()
  // 上次采纳提交若被中断，重开时定位到尚未完成的步骤继续执行，已生成的事项不会重复生成
  const interrupted = findInterrupted()
  for (const item of interrupted) {
    resumeMessage.value = `事件 ${item.row['事件编号']} 的采纳提交此前被中断，已从「${item.resumeStep}」继续执行`
    await acceptAdvice(Number(item.row.id), 200)
  }
  if (interrupted.length) {
    reload()
  }
})
</script>
