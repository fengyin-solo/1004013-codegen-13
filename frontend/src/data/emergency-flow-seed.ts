/**
 * 应急处置链路的示例数据：与 SEED_ROWS.emergency 对应。
 * 历史节点（如 EMER-0004）拿不到真实完成时间时 doneAt 留空，链路结构仍完整。
 */
import type { EmergencyFlowBundle, InspectionItem } from './emergency-flow'

export const EMERGENCY_FLOW_SEED: EmergencyFlowBundle = {
  flows: {
    1: {
      eventId: 1,
      steps: { report: { doneAt: '2026-10-05T08:00:00.000Z' } },
      suggestions: [],
      accepts: {},
      timeline: [
        { at: '2026-10-05T08:00:00.000Z', step: 'report', label: '接报', detail: '接报人 王磊 登记事件' },
      ],
    },
    2: {
      eventId: 2,
      steps: {
        report: { doneAt: '2026-10-04T09:30:00.000Z' },
        respond: { doneAt: '2026-10-04T10:20:00.000Z' },
      },
      suggestions: [],
      accepts: {},
      timeline: [
        { at: '2026-10-04T09:30:00.000Z', step: 'report', label: '接报', detail: '接报人 李敏 登记事件' },
        { at: '2026-10-04T10:20:00.000Z', step: 'respond', label: '启动响应', detail: '执行「启动响应」' },
      ],
    },
    3: {
      eventId: 3,
      steps: {
        report: { doneAt: '2026-10-03T07:10:00.000Z' },
        respond: { doneAt: '2026-10-03T08:00:00.000Z' },
        plan: { doneAt: '2026-10-03T11:30:00.000Z', plan: '导流疏通后清掏淤积物，复查井盖密封' },
      },
      suggestions: [],
      accepts: {},
      timeline: [
        { at: '2026-10-03T07:10:00.000Z', step: 'report', label: '接报', detail: '接报人 赵强 登记事件' },
        { at: '2026-10-03T08:00:00.000Z', step: 'respond', label: '启动响应', detail: '执行「启动响应」' },
        { at: '2026-10-03T11:30:00.000Z', step: 'plan', label: '制定方案', detail: '处置方案：导流疏通后清掏淤积物，复查井盖密封' },
      ],
    },
    4: {
      eventId: 4,
      steps: {
        report: { doneAt: '2026-09-20T14:00:00.000Z' },
        respond: { doneAt: '2026-09-20T14:20:00.000Z' },
        plan: { doneAt: '2026-09-20T15:00:00.000Z', plan: '紧急关停上下游阀门，开挖更换破损管节并试压恢复' },
        resolve: { doneAt: '2026-09-20T17:40:00.000Z' },
      },
      suggestions: [],
      accepts: {},
      timeline: [
        { at: '2026-09-20T14:00:00.000Z', step: 'report', label: '接报', detail: '接报人 周倩 登记事件' },
        { at: '2026-09-20T14:20:00.000Z', step: 'respond', label: '启动响应', detail: '执行「启动响应」' },
        { at: '2026-09-20T15:00:00.000Z', step: 'plan', label: '制定方案', detail: '处置方案：紧急关停上下游阀门，开挖更换破损管节并试压恢复' },
        { at: '2026-09-20T17:40:00.000Z', step: 'resolve', label: '确认处置', detail: '执行「确认处置」' },
      ],
    },
    5: {
      eventId: 5,
      steps: { report: { doneAt: '2026-09-18T22:15:00.000Z' } },
      suggestions: [],
      accepts: {},
      timeline: [
        { at: '2026-09-18T22:15:00.000Z', step: 'report', label: '接报', detail: '接报人 孙浩 登记事件（历史事件，处置时限缺失）' },
      ],
    },
    6: {
      eventId: 6,
      steps: { report: { doneAt: '2026-10-06T06:30:00.000Z' } },
      suggestions: [
        {
          key: 'EM-6-respond',
          eventId: 6,
          step: 'respond',
          level: '一级',
          deadline: '2026-10-06T07:18:00.000Z',
          overdueHours: 1,
          reportTo: '市政府应急办、属地抢险指挥部',
          measure: '立即集结抢险班组、调度抽排与封堵设备赶赴现场，同步封闭作业区',
          reason: '「启动响应」节点已超过处置时限，危害等级一级，建议升级响应。',
          status: 'accepted',
          decidedAt: '2026-10-06T08:05:00.000Z',
        },
      ],
      accepts: {
        // 演示：采纳向导停在「确认生成」之后、事项尚未写完，重开时定位到这一步且不重复生成。
        'EM-6-respond': {
          segmentsConfirmed: true,
          segmentIds: [1, 3],
          inspectionIds: [],
          defectIds: [],
        },
      },
      timeline: [
        { at: '2026-10-06T06:30:00.000Z', step: 'report', label: '接报', detail: '接报人 王磊 登记事件' },
        { at: '2026-10-06T08:05:00.000Z', step: 'respond', label: '采纳升级建议', detail: '响应升级为一级，上报市政府应急办、属地抢险指挥部，开始排查 2 个受影响管段' },
      ],
    },
  },
}

export const EMERGENCY_INSPECTION_SEED: InspectionItem[] = [
  {
    id: 1,
    itemNo: 'PAT-0001',
    eventId: 4,
    eventNo: 'EMER-0004',
    adviceKey: 'EM-4-resolve',
    segmentId: 0,
    segmentNo: '开发区纬二路DN600供排水管',
    location: '开发区纬二路工地',
    content: '更换破损管节后复查接口渗漏与回填沉降，确认试压合格',
    status: '已排查',
    createdAt: '2026-09-20T15:30:00.000Z',
  },
]
