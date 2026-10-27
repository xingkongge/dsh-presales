/**
 * 报价单 xlsx 版式（纯函数）：把 DTO 摊平成 单元格/合并/格式 指令。
 * 供 Host 用 /v7/sheets range_data/batch_update 写入 WPS 表格。
 */
export const COLS = ['序号', '产品类型', '产品名称', '单价', '单位', '数量', '总价', '备注']
const BLACK = { tint: 0, type: 1, value: 0 }
const BORDER = {
  dg_left: 1, dg_right: 1, dg_top: 1, dg_bottom: 1,
  clr_left: BLACK, clr_right: BLACK, clr_top: BLACK, clr_bottom: BLACK,
}
const TITLE = { font: { bls: true, sss: 20, name: '微软雅黑' }, alc_h: 2, alc_v: 1 }
const SUB = { font: { sss: 11, color: { tint: 0, type: 1, value: 6710886 } }, alc_h: 2, alc_v: 1 }
const INFO = { font: { sss: 11 }, alc_h: 1, alc_v: 1, ...BORDER }
const HEAD = { font: { bls: true, sss: 11 }, alc_h: 2, alc_v: 1, ...BORDER }
const SECT = { font: { bls: true, sss: 11 }, alc_h: 1, alc_v: 1, ...BORDER }
const CELL = { font: { sss: 11 }, alc_h: 2, alc_v: 1, ...BORDER }
const CELL_L = { font: { sss: 11 }, alc_h: 1, alc_v: 1, ...BORDER }
const TOTAL = { font: { bls: true, sss: 11 }, alc_h: 3, alc_v: 1, ...BORDER }
const FOOT = { font: { sss: 11 }, alc_h: 1, alc_v: 1 }

const money = (n) => Number(n || 0)

export function buildQuoteLayout(dto, meta = {}) {
  const rows = []
  const merges = []
  const formats = []
  const put = (r, c, v) => { if (v == null || v === '') return; rows.push({ r, c, v: String(v) }) }
  const merge = (r1, c1, r2, c2) => merges.push({ r1, c1, r2, c2 })
  const fmt = (r1, c1, r2, c2, xf) => formats.push({ r1, c1, r2, c2, xf })

  const title = `信云智联 ${dto.customerName || meta.customerName || ''} 报价单`.trim()
  put(0, 0, title); merge(0, 0, 0, 7); fmt(0, 0, 0, 7, TITLE)
  put(1, 0, `报价单号：${meta.quoteNo || ''}    日期：${meta.date || ''}`); merge(1, 0, 1, 7); fmt(1, 0, 1, 7, SUB)
  put(2, 0, `项目名称：${dto.customerName || meta.customerName || ''}`)
  put(2, 3, `报价人：${meta.sales || ''}`)
  put(2, 5, `有效期至：${meta.validUntil || ''}`)
  merge(2, 0, 2, 2); merge(2, 3, 2, 4); merge(2, 5, 2, 7); fmt(2, 0, 2, 7, INFO)
  COLS.forEach((h, i) => put(4, i, h))
  fmt(4, 0, 4, 7, HEAD)

  const groups = new Map()
  for (const l of dto.lines || []) {
    const k = l.section || '一、产品报价'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(l)
  }
  let r = 5
  let seq = 0
  for (const [section, items] of groups) {
    put(r, 0, section); merge(r, 0, r, 7); fmt(r, 0, r, 7, SECT); r += 1
    for (const l of items) {
      seq += 1
      const spec = [l.spec, l.brand, l.model].filter(Boolean).join(' / ')
      const name = spec ? `${l.name}\n${spec}` : l.name
      put(r, 0, seq); put(r, 1, l.category || ''); put(r, 2, name)
      put(r, 3, money(l.grossUnit)); put(r, 4, l.unit || ''); put(r, 5, l.qty)
      put(r, 6, money(l.grossSubtotal)); put(r, 7, l.remark || '')
      fmt(r, 0, r, 0, CELL); fmt(r, 1, r, 1, CELL)
      fmt(r, 2, r, 2, CELL_L); fmt(r, 3, r, 6, CELL); fmt(r, 7, r, 7, CELL_L)
      r += 1
    }
  }
  put(r, 0, '含税价格总计'); merge(r, 0, r, 5)
  put(r, 6, money(dto.totals?.grossTotal)); put(r, 7, '')
  fmt(r, 0, r, 7, TOTAL); r += 2

  put(r, 0, `未税合计：${money(dto.totals?.untaxedTotal)}    税额：${money(dto.totals?.taxTotal)}    含税合计：${money(dto.totals?.grossTotal)}`)
  merge(r, 0, r, 7); fmt(r, 0, r, 7, FOOT); r += 1
  const notes = meta.notes || dto.notes || ''
  if (notes) { put(r, 0, `报价说明：${notes}`); merge(r, 0, r, 7); fmt(r, 0, r, 7, FOOT); r += 1 }
  put(r, 0, '人民币：元，含税价。本报价单由数字售前生成。')
  merge(r, 0, r, 7); fmt(r, 0, r, 7, FOOT)
  return { rows, merges, formats, lastRow: r }
}
