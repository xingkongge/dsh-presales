import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildQuoteLayout } from '../lib/xlsx-layout.js'

const dto = {
  customerName: '中国建材集团某水泥子公司',
  lines: [
    { lineNo: 1, code: 'A', name: '智能安全生产管理系统', spec: 'S1', brand: '信云智联', model: 'M1', unit: '套', qty: 1, grossUnit: 813600, grossSubtotal: 813600, section: '一、软件产品', category: '安全生产管理软件' },
    { lineNo: 2, code: 'B', name: 'AI算法授权', unit: '项', qty: 2, grossUnit: 339000, grossSubtotal: 678000, section: '一、软件产品', category: 'AI算法' },
    { lineNo: 3, code: 'C', name: '安装实施', unit: '项', qty: 1, grossUnit: 50000, grossSubtotal: 50000, section: '三、安装实施', category: '实施服务' },
  ],
  totals: { untaxedTotal: 1000000, taxTotal: 130000, grossTotal: 1130000 },
}

describe('报价 xlsx 版式', () => {
  const layout = buildQuoteLayout(dto, { quoteNo: 'BJ-2026-0009', date: '2026-10-23', validUntil: '2026-11-22' })
  it('有标题/抬头/表头', () => {
    const vals = layout.rows.map((r) => r.v)
    assert.ok(vals.some((v) => v.includes('中国建材集团某水泥子公司 报价单')))
    assert.ok(vals.includes('序号'))
    assert.ok(vals.some((v) => v.includes('BJ-2026-0009')))
  })
  it('分节行与明细行数正确', () => {
    const sections = layout.rows.filter((r) => r.v === '一、软件产品' || r.v === '三、安装实施')
    assert.equal(sections.length, 2)
    // 明细：3 行
    const detail = layout.rows.filter((r) => ['安全生产管理软件', 'AI算法', '实施服务'].includes(r.v))
    assert.equal(detail.length, 3)
  })
  it('合计与合并', () => {
    assert.ok(layout.rows.some((r) => r.v === '含税价格总计'))
    assert.ok(layout.rows.some((r) => String(r.v) === '1130000'))
    assert.ok(layout.merges.length >= 5)
  })
})
