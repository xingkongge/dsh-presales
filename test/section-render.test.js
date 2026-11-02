import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSectionRanges,
  groupLinesBySection,
  planSectionWrites,
  DETAIL_SLOT_TOKENS,
  UNSECTIONED_TITLE,
} from '../lib/section-render.js'

// ── 夹具 ─────────────────────────────────────────────────────
const cell = (row, col, cellText) => ({ row_from: row, col_from: col, cell_text: cellText })

const HEAD = (row) => ([
  cell(row, 0, '{{序号}}'),
  cell(row, 1, '{{产品名称}}'),
  cell(row, 2, '{{数量}}'),
  cell(row, 3, '{{单价}}'),
  cell(row, 4, '{{总价}}'),
  cell(row, 5, '{{备注}}'),
])

const line = (lineNo, name, section, extra = {}) => ({
  lineNo,
  name,
  section,
  qty: extra.qty ?? 1,
  grossUnit: extra.grossUnit ?? 100,
  grossSubtotal: extra.grossSubtotal ?? 100,
  taxRate: extra.taxRate ?? 0.13,
  remark: extra.remark ?? '',
  unit: extra.unit ?? '套',
  category: extra.category ?? '软件',
  spec: extra.spec ?? '',
  brand: extra.brand ?? '',
  model: extra.model ?? '',
})

describe('buildSectionRanges 分节区间', () => {
  it('按行升序切区间，末节到表尾（max cell row + 1）', () => {
    const cells = [cell(0, 0, '标题'), ...HEAD(4), ...HEAD(9)]
    // 故意乱序传入
    const sections = [{ title: '二、实施服务', row: 10 }, { title: '一、软件产品', row: 4 }]
    const ranges = buildSectionRanges(sections, cells)
    assert.deepEqual(ranges, [
      { title: '一、软件产品', row: 4, startRow: 4, endRow: 10, fallback: false },
      { title: '二、实施服务', row: 10, startRow: 10, endRow: 10 + 1, fallback: false },
    ])
  })

  it('表尾由最后一个单元格行 + 1 决定，sheetEnd 可覆盖', () => {
    const cells = [cell(4, 0, '一、软件产品'), ...HEAD(5)]
    const ranges = buildSectionRanges([{ title: '一、软件产品', row: 4 }], cells)
    assert.equal(ranges[0].endRow, 6)
    const hinted = buildSectionRanges([{ title: '一、软件产品', row: 4 }], cells, { sheetEnd: 81 })
    assert.equal(hinted[0].endRow, 81)
  })

  it('同 row 的分节去重、row=null 的条目被忽略', () => {
    const cells = [cell(0, 0, 'x'), cell(7, 0, 'y')]
    const ranges = buildSectionRanges([
      { title: 'A', row: 3 },
      { title: 'B', row: 3 },
      { title: 'C', row: null },
    ], cells)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0].title, 'A')
  })

  it('没有有效分节行 → 单个 fallback 区间', () => {
    const cells = [...HEAD(2), ...HEAD(3)]
    const ranges = buildSectionRanges([{ title: '产品报价', row: null }], cells)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0].fallback, true)
    assert.equal(ranges[0].startRow, 0)
    assert.equal(ranges[0].endRow, 4)
    assert.deepEqual(buildSectionRanges([], cells).map((r) => r.fallback), [true])
  })
})

describe('groupLinesBySection 分组', () => {
  const sections = [
    { title: '一、软件产品', row: 3 },
    { title: '二、实施服务', row: 8 },
  ]
  const lines = [
    line(1, 'A1', '一、软件产品'),
    line(2, 'B1', '二、实施服务'),
    line(3, 'A2', '一、软件产品'),
    line(4, 'X', '三、运维服务'),
    line(5, 'Y', ''),
  ]

  it('按 title 精确匹配分节，保持输入顺序', () => {
    const { groups, ranges, unsectioned, fallback } = groupLinesBySection(lines, sections)
    assert.equal(fallback, false)
    assert.equal(ranges.length, 2)
    assert.deepEqual(groups[0].items.map((l) => l.name), ['A1', 'A2'])
    assert.deepEqual(groups[1].items.map((l) => l.name), ['B1'])
    assert.deepEqual(unsectioned.map((l) => l.name), ['X', 'Y'])
  })

  it('未匹配行归入「未分节」分组', () => {
    const { groups } = groupLinesBySection(lines, sections)
    const bucket = groups.find((g) => g.title === UNSECTIONED_TITLE)
    assert.ok(bucket, '应有未分节分组')
    assert.equal(bucket.unmatched, true)
    assert.deepEqual(bucket.items.map((l) => l.name), ['X', 'Y'])
  })

  it('fallback 模式（模板无分节行）所有行进唯一分组', () => {
    const { groups, unsectioned, fallback } = groupLinesBySection(lines, [{ title: '产品报价', row: null }])
    assert.equal(fallback, true)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].items.length, lines.length)
    assert.equal(unsectioned.length, 0)
  })
})

describe('planSectionWrites 写入计划', () => {
  it('单节多行：每行都按顺序拿到自己的 item', () => {
    const sections = [{ title: '一、软件产品', row: 5 }]
    const cells = [
      cell(5, 0, '一、软件产品'),
      ...HEAD(6), ...HEAD(7), ...HEAD(8),
      cell(9, 0, '含税合计：{{含税合计}}'),
    ]
    const lines = [
      line(1, '智能安全生产管理系统', '一、软件产品', { qty: 2, grossUnit: 813600, grossSubtotal: 1627200 }),
      line(2, 'AI算法授权', '一、软件产品', { qty: 3 }),
      line(3, '数据治理平台', '一、软件产品'),
    ]
    const plan = planSectionWrites(lines, sections, cells)
    assert.equal(plan.fallback, false)
    assert.deepEqual(plan.overflow, [])
    assert.deepEqual(plan.unmatched, [])
    assert.deepEqual(plan.emptySlots, [])
    assert.deepEqual(plan.unresolved, [])
    // 3 行 × 6 列
    assert.equal(plan.writes.length, 18)
    const at = (row, col) => plan.writes.find((w) => w.row === row && w.col === col)
    assert.deepEqual(at(6, 0), { row: 6, col: 0, token: '{{序号}}', text: '1' })
    assert.equal(at(6, 1).text, '智能安全生产管理系统')
    assert.equal(at(6, 2).text, '2')
    assert.equal(at(6, 3).text, '813600')
    assert.equal(at(6, 4).text, '1627200')
    assert.equal(at(7, 1).text, 'AI算法授权')
    assert.equal(at(8, 1).text, '数据治理平台')
    // 抬头行（非占位行）不写
    assert.equal(plan.writes.some((w) => w.row === 9), false)
    // writes 按 (row, col) 升序
    const sorted = [...plan.writes].sort((a, b) => (a.row - b.row) || (a.col - b.col))
    assert.deepEqual(plan.writes, sorted)
  })

  it('多节各多行：各节只吃自己节的 item，序号不串节', () => {
    const sections = [
      { title: '一、软件产品', row: 3 },
      { title: '二、实施服务', row: 8 },
    ]
    const cells = [
      cell(3, 0, '一、软件产品'),
      ...HEAD(4), ...HEAD(5),
      cell(8, 0, '二、实施服务'),
      ...HEAD(9), ...HEAD(10),
      cell(11, 0, '含税合计：{{含税合计}}'),
    ]
    const lines = [
      line(1, 'A1', '一、软件产品'),
      line(2, 'B1', '二、实施服务'),
      line(3, 'A2', '一、软件产品'),
      line(4, 'B2', '二、实施服务'),
    ]
    const plan = planSectionWrites(lines, sections, cells)
    const nameAt = (row) => plan.writes.find((w) => w.row === row && w.col === 1).text
    const seqAt = (row) => plan.writes.find((w) => w.row === row && w.col === 0).text
    assert.deepEqual([nameAt(4), nameAt(5), nameAt(9), nameAt(10)], ['A1', 'A2', 'B1', 'B2'])
    assert.deepEqual([seqAt(4), seqAt(5), seqAt(9), seqAt(10)], ['1', '3', '2', '4'])
    assert.deepEqual(plan.overflow, [])
    assert.deepEqual(plan.unmatched, [])
  })

  it('节内占位不足 → overflow（多余 item 上报，不串到别的节）', () => {
    const sections = [
      { title: '一、软件产品', row: 3 },
      { title: '二、实施服务', row: 8 },
    ]
    const cells = [
      cell(3, 0, '一、软件产品'),
      ...HEAD(4), ...HEAD(5),
      cell(8, 0, '二、实施服务'),
      ...HEAD(9),
    ]
    const lines = [
      line(1, 'A1', '一、软件产品'),
      line(2, 'A2', '一、软件产品'),
      line(3, 'A3', '一、软件产品'),
      line(4, 'B1', '二、实施服务'),
    ]
    const plan = planSectionWrites(lines, sections, cells)
    assert.equal(plan.writes.filter((w) => w.col === 1).length, 3)
    assert.deepEqual(plan.overflow, [
      { lineNo: 3, name: 'A3', section: '一、软件产品', reason: 'no-slot' },
    ])
    // A3 绝不能落到「二、实施服务」的占位行上
    assert.equal(plan.writes.some((w) => w.text === 'A3'), false)
    assert.equal(plan.writes.find((w) => w.row === 9 && w.col === 1).text, 'B1')
  })

  it('未知 section → unmatched，未分节行不写入', () => {
    const sections = [{ title: '一、软件产品', row: 3 }]
    const cells = [cell(3, 0, '一、软件产品'), ...HEAD(4)]
    const lines = [
      line(1, 'A1', '一、软件产品'),
      line(2, 'X1', '三、运维服务'),
      line(3, 'Y1', ''),
    ]
    const plan = planSectionWrites(lines, sections, cells)
    assert.deepEqual(plan.unmatched, [
      { lineNo: 2, name: 'X1', section: '三、运维服务', reason: 'unknown-section' },
      { lineNo: 3, name: 'Y1', section: '', reason: 'no-section' },
    ])
    assert.deepEqual(plan.overflow, [])
    assert.deepEqual(plan.writes.map((w) => w.text).filter((t) => t === 'X1' || t === 'Y1'), [])
    assert.equal(plan.writes.find((w) => w.row === 4 && w.col === 1).text, 'A1')
  })

  it('无分节 fallback：全部明细按输入顺序铺占位行', () => {
    const sections = [{ title: '产品报价', row: null }]
    const cells = [cell(0, 0, '报价单'), ...HEAD(2), ...HEAD(3), ...HEAD(4)]
    const lines = [
      line(1, 'A1', '一、软件产品'),
      line(2, 'B1', '二、实施服务'),
      line(3, 'C1', ''),
    ]
    const plan = planSectionWrites(lines, sections, cells)
    assert.equal(plan.fallback, true)
    assert.deepEqual(plan.unmatched, [])
    assert.deepEqual(plan.overflow, [])
    assert.deepEqual(plan.emptySlots, [])
    assert.deepEqual(
      plan.writes.filter((w) => w.col === 1).map((w) => w.text),
      ['A1', 'B1', 'C1'],
    )
    assert.deepEqual(
      plan.writes.filter((w) => w.col === 1).map((w) => w.row),
      [2, 3, 4],
    )
  })

  it('模板占位行多于明细 → emptySlots，且不写多余行', () => {
    const sections = [{ title: '一、软件产品', row: 3 }]
    const cells = [cell(3, 0, '一、软件产品'), ...HEAD(4), ...HEAD(5), ...HEAD(6)]
    const lines = [line(1, 'A1', '一、软件产品')]
    const plan = planSectionWrites(lines, sections, cells)
    assert.deepEqual(plan.emptySlots, [
      { row: 5, section: '一、软件产品', reason: 'no-item' },
      { row: 6, section: '一、软件产品', reason: 'no-item' },
    ])
    assert.equal(plan.writes.filter((w) => w.col === 1).length, 1)
    // 空行里的 {{序号}} 保持原样（留给模板清理/人工处理），不产生错位写入
    assert.equal(plan.writes.some((w) => w.row === 5 || w.row === 6), false)
  })

  it('明细 token 渲染：数量/单价/税率/备注，未知 token 保留原文并上报', () => {
    const sections = [{ title: '一、软件产品', row: 2 }]
    const cells = [
      cell(2, 0, '一、软件产品'),
      cell(3, 0, '{{序号}}'),
      cell(3, 1, '{{产品名称}}'),
      cell(3, 2, '{{规格}}'),
      cell(3, 3, '{{数量}}'),
      cell(3, 4, '{{单价}}'),
      cell(3, 5, '{{税率}}'),
      cell(3, 6, '{{备注}}'),
      cell(3, 7, '{{自定义占位}}'),
    ]
    const lines = [line(7, 'AI算法授权', '一、软件产品', { spec: 'S1', qty: 2, grossUnit: 339000, taxRate: 0.13, remark: '含三年维保' })]
    const plan = planSectionWrites(lines, sections, cells)
    const at = (col) => plan.writes.find((w) => w.row === 3 && w.col === col)
    assert.deepEqual(at(0), { row: 3, col: 0, token: '{{序号}}', text: '7' })
    assert.equal(at(2).text, 'S1')
    assert.equal(at(3).text, '2')
    assert.equal(at(4).text, '339000')
    assert.equal(at(5).text, '13%')
    assert.equal(at(6).text, '含三年维保')
    // 未知 token 不覆盖、单独上报
    assert.equal(at(7), undefined)
    assert.deepEqual(plan.unresolved, [{ row: 3, col: 7, token: '{{自定义占位}}' }])
  })

  it('scalars 选项可解析同行混排的抬头 token', () => {
    const sections = [{ title: '一、软件产品', row: 2 }]
    const cells = [
      cell(2, 0, '一、软件产品'),
      cell(3, 0, '{{序号}}'),
      cell(3, 1, '{{产品名称}}'),
      cell(3, 2, '{{项目名称}}'),
    ]
    const lines = [line(1, 'A1', '一、软件产品')]
    const plan = planSectionWrites(lines, sections, cells, { scalars: { '{{项目名称}}': '某水泥集团' } })
    assert.equal(plan.writes.find((w) => w.col === 2).text, '某水泥集团')
    assert.deepEqual(plan.unresolved, [])
  })

  it('cells 为空：无写入；分节模式下明细全部 overflow', () => {
    const plan = planSectionWrites(
      [line(1, 'A1', '一、软件产品')],
      [{ title: '一、软件产品', row: 3 }],
      [],
    )
    assert.deepEqual(plan.writes, [])
    assert.deepEqual(plan.overflow, [{ lineNo: 1, name: 'A1', section: '一、软件产品', reason: 'no-slot' }])
    assert.deepEqual(plan.emptySlots, [])
  })

  it('占位行落在所有分节之外 → emptySlots outside-section', () => {
    const sections = [{ title: '一、软件产品', row: 5 }]
    const cells = [cell(1, 0, '报价单'), ...HEAD(2), ...HEAD(6)]
    // row 2 的表头占位行在第一个分节（row 5）之前
    const plan = planSectionWrites([line(1, 'A1', '一、软件产品')], sections, cells)
    assert.deepEqual(plan.emptySlots, [{ row: 2, section: null, reason: 'outside-section' }])
    assert.equal(plan.writes.every((w) => w.row === 6), true)
  })
})

describe('模块契约', () => {
  it('导出常量与纯函数（无 WPS 依赖）', () => {
    assert.deepEqual(DETAIL_SLOT_TOKENS, ['{{序号}}', '{{产品名称}}'])
    assert.equal(typeof buildSectionRanges, 'function')
    assert.equal(typeof groupLinesBySection, 'function')
    assert.equal(typeof planSectionWrites, 'function')
  })

  it('不修改入参', () => {
    const sections = [{ title: '一、软件产品', row: 3 }]
    const cells = [cell(3, 0, '一、软件产品'), ...HEAD(4), ...HEAD(5)]
    const lines = [line(1, 'A1', '一、软件产品'), line(2, 'A2', '一、软件产品')]
    const snapshot = JSON.stringify({ sections, cells, lines })
    const plan = planSectionWrites(lines, sections, cells)
    assert.ok(plan.writes.length > 0)
    assert.equal(JSON.stringify({ sections, cells, lines }), snapshot)
  })
})
