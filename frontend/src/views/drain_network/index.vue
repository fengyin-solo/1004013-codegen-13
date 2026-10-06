<template>
  <section class="page" data-module="drain_network">
    <header class="page-head">
      <div>
        <h2>排水管网管理</h2>
        <p class="page-desc">维护排水管段，围绕管段编号、上游节点、下游节点、管段长度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排水管段</button>
        <button class="btn" type="button" @click="exportRows">导出排水管网清单</button>
      </div>
    </header>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无排水管网数据，可先登记排水管段</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水管网记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="check-section">
      <h3>受影响管段排查事项</h3>
      <p class="page-desc">应急事件采纳升级建议后自动生成，按 待排查 → 排查中 → 已排查 依次推进。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>事项编号</th>
            <th>来源事件</th>
            <th>管段编号</th>
            <th>排查要求</th>
            <th>生成时间</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="check in checks" :key="String(check.id)">
            <td>{{ check['事项编号'] }}</td>
            <td>{{ check['来源事件'] }}</td>
            <td>{{ check['管段编号'] }}</td>
            <td>{{ check['排查要求'] }}</td>
            <td>{{ check['生成时间'] }}</td>
            <td>{{ check.status }}</td>
            <td class="row-actions">
              <button
                v-if="nextCheckLabel(check)"
                class="link"
                type="button"
                @click="advance(check)"
              >
                {{ nextCheckLabel(check) }}
              </button>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!checks.length">
            <td colspan="7" class="empty-state">暂无受影响管段排查事项</td>
          </tr>
        </tbody>
      </table>
    </section>
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
import { CHECK_NEXT_LABEL, advanceCheck, listChecks } from '@/api/emergency-flow'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drain_network')
const columns = ["管段编号", "上游节点", "下游节点", "管段长度", "断面尺寸", "设计坡度", "排水能力", "运行状况"]
const actions = ["标记淤积", "预警溢流", "确认封堵"]
const statuses = ["正常", "淤积预警", "溢流风险", "已封堵"]
const stats = [{"label": "管段总数", "value": 0}, {"label": "淤积预警管段", "value": 0}, {"label": "溢流风险管段", "value": 0}]

const rows = ref<EntryRow[]>([])
const checks = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '排水管段登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水管网列表读取失败'
  }
}

function nextCheckLabel(check: EntryRow): string {
  return CHECK_NEXT_LABEL[String(check.status)] ?? ''
}

function advance(check: EntryRow) {
  errorMessage.value = ''
  const result = advanceCheck(Number(check.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reloadChecks()
}

function reloadChecks() {
  checks.value = listChecks()
}

onMounted(() => {
  reload()
  reloadChecks()
})
</script>
