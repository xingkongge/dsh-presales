/**
 * 分节感知渲染（纯函数）：把报价 dto.lines 按模板分节分配到明细占位行。
 *
 * 不依赖任何 WPS API —— 输入输出都是普通对象，供 index.js 的
 * copyTemplateAndFill 组装 /v7/sheets range_data/batch_update 用。
 *
 * 输入约定
 * - sections: [{ title, row }]  模板识别出的分节标题行；row = null 或非整数表示
 *             “模板没有分节行”（fallback 模式，由 index.js 的 templateSections 返回）。
 * - cells:    [{ row_from, col_from, cell_text }]  WPS /v7/sheets range_data 的原始单元格。
 *             也接受 { row, col, text } 写法（本地拼装时方便）。
 * - lines:    dto.lines，元素含 section / lineNo / name / qty / grossUnit ...
 *
 * 区间语义
 * - 分节区间是 [startRow, endRow) —— **包含分节标题行自身**，到下一个分节标题行前一行为止；
 *   最后一个分节到 max(cell.row_from) + 1（可用 options.sheetEnd 覆盖，
 *   例如模板扫描只读到 80 行时传 sheetEnd=81）。
 * - cells 为空时无法推断表尾，退化为 startRow + 1（此时也没有占位行可分配）。
 */

export const DETAIL_SLOT_TOKENS = ['{{序号}}', '{{产品名称}}']
export const UNSECTIONED_TITLE = '未分节'
export const FALLBACK_TITLE = '产品报价'

const TOKEN_RE = /\{\{[^{}]+\}\}/g

const str = (v) => (v == null ? '' : String(v))
const text = (v) => str(v).trim()

function toRowNo(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function normLines(lines) {
  const list = Array.isArray(lines) ? lines : []
  return list.map((raw, i) => {
    const l = raw && typeof raw === 'object' ? { ...raw } : {}
    if (l.lineNo == null || l.lineNo === '') l.lineNo = i + 1
    return l
  })
}

function normCells(cells) {
  const list = Array.isArray(cells) ? cells : []
  return list
    .map((c) => ({
      row: toRowNo(c?.row_from ?? c?.row),
      col: toRowNo(c?.col_from ?? c?.col),
      text: str(c?.cell_text ?? c?.text),
    }))
    .filter((c) => c.row !== null && c.col !== null)
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))
}

/** 明细 token → item 字段。返回 undefined 表示“不是明细 token”，交给 scalar / 保留原文。 */
function detailValue(item, token) {
  if (!item) return undefined
  switch (token) {
    case '{{序号}}': return str(item.lineNo)
    case '{{产品类型}}': return str(item.category)
    case '{{产品名称}}': return str(item.name)
    case '{{产品名称/规格描述}}': return str(item.name)
    case '{{规格}}':
    case '{{规格描述}}': return str(item.spec)
    case '{{模块名称}}': return str(item.module)
    case '{{品牌}}': return str(item.brand)
    case '{{型号}}': return str(item.model)
    case '{{单价}}':
    case '{{含税单价}}': return str(item.grossUnit)
    case '{{单位}}': return str(item.unit)
    case '{{数量}}': return str(item.qty)
    case '{{总价}}': return str(item.grossSubtotal)
    case '{{税率}}': return taxText(item.taxRate)
    case '{{备注}}': return str(item.remark)
    default: return undefined
  }
}

function taxText(rate) {
  if (rate == null || rate === '') return ''
  const n = Number(rate)
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : ''
}

/** 已经算好的区间（buildSectionRanges 的产物）直接复用，否则从原始 sections 推算。 */
function toRanges(sections, cells = []) {
  const list = Array.isArray(sections) ? sections : []
  const isRange = list.length > 0 && list.every(
    (r) => r && toRowNo(r.startRow) !== null && toRowNo(r.endRow) !== null,
  )
  if (isRange) {
    return list.map((r) => ({
      title: text(r.title),
      row: toRowNo(r.row),
      startRow: toRowNo(r.startRow),
      endRow: toRowNo(r.endRow),
      fallback: !!r.fallback,
    }))
  }
  return buildSectionRanges(list, cells)
}

/**
 * 分节区间。
 * @returns {Array<{title:string,row:number|null,startRow:number,endRow:number,fallback:boolean}>}
 *   按 startRow 升序；无有效分节行时返回单个 fallback 区间（title 取 sections[0].title）。
 */
export function buildSectionRanges(sections, cells = [], options = {}) {
  const source = Array.isArray(sections) ? sections : []
  const cs = normCells(cells)
  const maxCellRow = cs.length ? cs[cs.length - 1].row : null
  const hintEnd = toRowNo(options?.sheetEnd)

  const seen = new Set()
  const rows = []
  for (const s of source) {
    const row = toRowNo(s?.row)
    if (row === null || seen.has(row)) continue
    seen.add(row)
    rows.push({ title: text(s.title), row })
  }
  rows.sort((a, b) => a.row - b.row)

  if (!rows.length) {
    const title = text(source[0]?.title) || FALLBACK_TITLE
    const end = hintEnd ?? (maxCellRow !== null ? maxCellRow + 1 : 1)
    return [{ title, row: null, startRow: 0, endRow: Math.max(end, 1), fallback: true }]
  }

  return rows.map((s, i) => {
    const next = rows[i + 1]
    const rawEnd = next ? next.row : (hintEnd ?? (maxCellRow !== null ? maxCellRow + 1 : s.row + 1))
    return {
      title: s.title,
      row: s.row,
      startRow: s.row,
      endRow: rawEnd > s.row ? rawEnd : s.row + 1,
      fallback: false,
    }
  })
}

/**
 * 按 line.section 精确匹配分节 title（先 trim 再全等，不做过/模糊匹配）。
 * 未匹配行归入「未分节」分组并原样报告；fallback 模式下所有行进唯一分组。
 */
export function groupLinesBySection(lines, sections, cells = []) {
  const ranges = toRanges(sections, cells)
  const ls = normLines(lines)
  const fallback = ranges.length === 1 && !!ranges[0].fallback
  const groups = ranges.map((r) => ({ ...r, items: [] }))

  const firstByTitle = new Map()
  for (const g of groups) if (!firstByTitle.has(g.title)) firstByTitle.set(g.title, g)

  const unsectioned = []
  for (const l of ls) {
    if (fallback) {
      groups[0].items.push(l)
      continue
    }
    const g = firstByTitle.get(text(l.section))
    if (g) g.items.push(l)
    else unsectioned.push(l)
  }
  if (unsectioned.length) {
    groups.push({
      title: UNSECTIONED_TITLE,
      row: null,
      startRow: null,
      endRow: null,
      fallback: false,
      unmatched: true,
      items: unsectioned,
    })
  }
  return { ranges, groups, unsectioned, fallback }
}

/**
 * 分节感知的写入计划。
 *
 * @param lines   dto.lines
 * @param sections [{title,row}] 或 buildSectionRanges 的结果
 * @param cells   [{row_from,col_from,cell_text}]
 * @param options { slotTokens?: string[], scalars?: Record<string,any> }
 *   - slotTokens 覆盖默认的明细占位 token 列表
 *   - scalars 额外 token 表（如 {{项目名称}}），用于同一行里混排的抬头 token
 * @returns {{
 *   writes: Array<{row:number,col:number,token:string,text:string}>,
 *   overflow: Array<{lineNo:any,name:string,section:string,reason:'no-slot'}>,
 *   unmatched: Array<{lineNo:any,name:string,section:string,reason:'unknown-section'|'no-section'}>,
 *   emptySlots: Array<{row:number,section:string|null,reason:'no-item'|'outside-section'}>,
 *   unresolved: Array<{row:number,col:number,token:string}>,
 *   fallback: boolean
 * }}
 *
 * - overflow：分节匹配上了，但该节占位行不够 → 装不下的 item（节内占位不足）。
 * - unmatched：line.section 在模板里找不到对应分节 → 未分节（含 section 为空）。
 * - emptySlots：占位行没分到 item（模板行多于明细行），这些行不会被写，需要的话自行清空。
 * - writes 按 (row, col) 升序，可直接映射为 batch_update 的 range_data。
 */
export function planSectionWrites(lines, sections, cells = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const scalars = opts.scalars && typeof opts.scalars === 'object' ? opts.scalars : {}
  const customTokens = Array.isArray(opts.slotTokens) && opts.slotTokens.length
    ? opts.slotTokens.map(String)
    : null
  const slotTokens = customTokens || DETAIL_SLOT_TOKENS

  const cs = normCells(cells)
  const grouped = groupLinesBySection(lines, sections, cells)
  const { ranges, fallback } = grouped
  const ls = normLines(lines)

  // 每个区间一条按输入顺序排列的 item 队列
  const pools = ranges.map((r) => ({ title: r.title, items: [] }))
  const firstIdx = new Map()
  ranges.forEach((r, i) => { if (!firstIdx.has(r.title)) firstIdx.set(r.title, i) })

  const unmatched = []
  for (const l of ls) {
    if (fallback) {
      pools[0].items.push(l)
      continue
    }
    const i = firstIdx.get(text(l.section))
    if (i === undefined) {
      const section = text(l.section)
      unmatched.push({
        lineNo: l.lineNo,
        name: str(l.name),
        section,
        reason: section ? 'unknown-section' : 'no-section',
      })
    } else {
      pools[i].items.push(l)
    }
  }

  const isSlotCell = (t) => slotTokens.some((tok) => t.includes(tok))
  const slotRows = [...new Set(cs.filter((c) => isSlotCell(c.text)).map((c) => c.row))].sort((a, b) => a - b)

  const cellsByRow = new Map()
  for (const c of cs) {
    if (!cellsByRow.has(c.row)) cellsByRow.set(c.row, [])
    cellsByRow.get(c.row).push(c)
  }

  const writes = []
  const overflow = []
  const emptySlots = []
  const unresolved = []
  const cursors = pools.map(() => 0)

  for (const row of slotRows) {
    const ri = ranges.findIndex((r) => row >= r.startRow && row < r.endRow)
    if (ri < 0) {
      emptySlots.push({ row, section: null, reason: 'outside-section' })
      continue
    }
    if (cursors[ri] >= pools[ri].items.length) {
      emptySlots.push({ row, section: pools[ri].title, reason: 'no-item' })
      continue
    }
    const item = pools[ri].items[cursors[ri]]
    cursors[ri] += 1

    for (const c of cellsByRow.get(row) || []) {
      if (!c.text.includes('{{')) continue
      const tokens = c.text.match(TOKEN_RE) || []
      if (!tokens.length) continue
      const unknown = []
      const value = c.text.replace(TOKEN_RE, (m) => {
        const v = detailValue(item, m)
        if (v !== undefined) return v
        if (Object.prototype.hasOwnProperty.call(scalars, m)) return str(scalars[m])
        unknown.push(m)
        return m
      })
      for (const u of unknown) unresolved.push({ row, col: c.col, token: u })
      if (value === c.text) continue // 整格一个 token 都没解析出来 → 不写，避免无意义覆盖
      const token = tokens.find((t) => detailValue(item, t) !== undefined) || tokens[0]
      writes.push({ row, col: c.col, token, text: value })
    }
  }

  pools.forEach((p, i) => {
    for (let k = cursors[i]; k < p.items.length; k += 1) {
      const l = p.items[k]
      overflow.push({ lineNo: l.lineNo, name: str(l.name), section: p.title, reason: 'no-slot' })
    }
  })

  writes.sort((a, b) => (a.row - b.row) || (a.col - b.col))
  return { writes, overflow, unmatched, emptySlots, unresolved, fallback }
}
