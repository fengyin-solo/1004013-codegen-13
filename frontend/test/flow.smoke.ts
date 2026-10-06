// 冒烟测试：在 node 里跑应急处置链路（localStorage 不存在时 local-store 用内存种子数据）
import assert from 'node:assert'
import { runAction, listEntries } from '@/api/local-service'
import {
  CHECK_KEY,
  acceptAdvice,
  buildAdvice,
  findInterrupted,
  listChecks,
  nextActionOf,
  rejectAdvice,
  supplementDeadline,
} from '@/api/emergency-flow'
import { listRows, saveRows } from '@/data/local-store'

const NOW = new Date('2026-10-06T10:00:00')

// 1. 升级建议：EMER-0001 接报 2026-10-05 08:00 + 12h，已超时 → level 3，建议启动响应
const emer1 = listRows('emergency').find((r) => r['事件编号'] === 'EMER-0001')!
const advice1 = buildAdvice(emer1, NOW)
assert.ok(advice1, 'EMER-0001 应生成建议')
assert.equal(advice1.level, 3)
assert.equal(advice1.nextAction, '启动响应')
console.log('✓ 超时建议生成：', advice1.text)

// 2. 历史事件缺时限：EMER-0003/0004 处置时限为空 → 不出建议
const emer3 = listRows('emergency').find((r) => r['事件编号'] === 'EMER-0003')!
assert.equal(buildAdvice(emer3, NOW), null)
console.log('✓ 历史事件时限为空，不出建议')

// 3. 状态机：不能跳级（待响应 → 确认处置），不能回退
const jump = runAction('emergency', 1, '确认处置')
assert.equal(jump.ok, false)
assert.ok(jump.message.includes('依次推进'), jump.message)
console.log('✓ 跳级被拦截：', jump.message)

// 4. 采纳建议：状态推进一级 + 生成排查事项 + 关联缺陷
const accepted = await acceptAdvice(1, 0)
assert.ok(accepted.ok, accepted.message)
const after1 = listRows('emergency').find((r) => r.id === 1)!
assert.equal(after1.status, '响应中')
assert.equal(after1['采纳进度'], '缺陷已关联')
const checks1 = listChecks().filter((c) => c['来源事件'] === 'EMER-0001')
assert.equal(checks1.length, 2)
assert.deepEqual(checks1.map((c) => c['管段编号']).sort(), ['DRAI-0001', 'DRAI-0002'])
const defect1 = listRows('defect').find((d) => d['缺陷编号'] === 'DEFE-0001')!
assert.equal(defect1['关联应急事件'], 'EMER-0001')
console.log('✓ 采纳完成：状态→响应中，排查事项 2 条，DEFE-0001 已关联')

// 5. 幂等：重复采纳不重复生成
await acceptAdvice(1, 0)
assert.equal(listChecks().filter((c) => c['来源事件'] === 'EMER-0001').length, 2)
console.log('✓ 重复采纳不重复生成排查事项')

// 6. 断点续传：模拟 EMER-0002 在「生成排查事项」前被打断
saveRows(
  'emergency',
  listRows('emergency').map((r) =>
    r.id === 2 ? { ...r, status: '处置中', 采纳进度: '状态已推进' } : r,
  ),
)
const interrupted = findInterrupted()
assert.equal(interrupted.length, 1)
assert.equal(interrupted[0].resumeStep, '生成受影响管段排查事项')
console.log('✓ 断点定位：', `EMER-0002 从「${interrupted[0].resumeStep}」继续`)
const resumed = await acceptAdvice(2, 0)
assert.ok(resumed.ok, resumed.message)
const checks2 = listChecks().filter((c) => c['来源事件'] === 'EMER-0002')
assert.equal(checks2.length, 1)
assert.equal(checks2[0]['管段编号'], 'DRAI-0003')
assert.equal(listRows('defect').find((d) => d['缺陷编号'] === 'DEFE-0002')!['关联应急事件'], 'EMER-0002')
assert.equal(findInterrupted().length, 0)
// 状态未被重复推进（断点前已是处置中）
assert.equal(listRows('emergency').find((r) => r.id === 2)!.status, '处置中')
console.log('✓ 断点续传完成：事项不重复，状态未重复推进')

// 7. 退回建议：EMER-0002 处置中，时限 24h 已超时 → level 3；退回后同级别不再出现
const emer2 = listRows('emergency').find((r) => r.id === 2)!
assert.ok(buildAdvice(emer2, NOW))
const rejected = rejectAdvice(2)
assert.ok(rejected.ok, rejected.message)
assert.equal(buildAdvice(listRows('emergency').find((r) => r.id === 2)!, NOW), null)
assert.equal(listRows('emergency').find((r) => r.id === 2)!['建议状态'], '已退回')
console.log('✓ 建议退回后不再提醒（同级别）')

// 8. 补录时限后重算：EMER-0003 补录 48h → 接报 09-03 起算已超时 → 重新出建议
const supplemented = supplementDeadline(3, 48)
assert.ok(supplemented.ok, supplemented.message)
const emer3After = listRows('emergency').find((r) => r.id === 3)!
assert.equal(emer3After['处置时限'], '48')
const advice3 = buildAdvice(emer3After, NOW)
assert.ok(advice3, '补录后应重新生成建议')
assert.equal(advice3.nextAction, '确认处置')
console.log('✓ 补录时限后重算：', advice3.text)

// 9. 依次推进到已处置后，任何动作都被拒
runAction('emergency', 3, '确认处置')
const final = runAction('emergency', 3, '启动响应')
assert.equal(final.ok, false)
assert.equal(nextActionOf(listRows('emergency').find((r) => r.id === 3)!), null)
console.log('✓ 已处置后不可再流转：', final.message)

// 10. 导出与列表不受影响
assert.ok(listEntries('emergency').total >= 4)
assert.ok(listRows(CHECK_KEY).length === 3)
console.log('✓ 列表与排查事项数据一致')

console.log('\n全部冒烟断言通过')
