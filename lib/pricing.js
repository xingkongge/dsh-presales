/**
 * 报价计价引擎（纯函数，无 IO）。
 * 口径：产品标准价/成本价为不含税；报价行按折扣计算未税单价，再算税额与含税价。
 */

export const DEFAULT_TAX_RATE = 0.13
export const DEFAULT_MIN_MARGIN = 0.15

export function round(n, digits = 2) {
  const f = 10 ** digits
  return Math.round((Number(n) + Number.EPSILON) * f) / f
}

export function round4(n) { return round(n, 4) }
export function round2(n) { return round(n, 2) }

/** 单行计价。stdPrice/costPrice 为不含税价。 */
export function computeLine({ stdPrice, costPrice = 0, discount = 1, qty = 1, taxRate = DEFAULT_TAX_RATE }) {
  const untaxedUnit = round4(Number(stdPrice) * Number(discount))
  const untaxedSubtotal = round2(untaxedUnit * Number(qty))
  const tax = round2(untaxedSubtotal * Number(taxRate))
  const grossUnit = round4(untaxedUnit * (1 + Number(taxRate)))
  const grossSubtotal = round2(untaxedSubtotal + tax)
  const costSubtotal = round2(Number(costPrice) * Number(qty))
  return { untaxedUnit, untaxedSubtotal, taxRate: Number(taxRate), tax, grossUnit, grossSubtotal, costSubtotal }
}

/** 汇总多行。 */
export function computeTotals(lines) {
  const untaxed = round2(lines.reduce((s, l) => s + l.untaxedSubtotal, 0))
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0))
  const gross = round2(lines.reduce((s, l) => s + l.grossSubtotal, 0))
  const cost = round2(lines.reduce((s, l) => s + l.costSubtotal, 0))
  const profit = round2(untaxed - cost)
  const margin = untaxed > 0 ? round(profit / untaxed, 4) : null
  return { untaxedTotal: untaxed, taxTotal: tax, grossTotal: gross, costTotal: cost, profit, margin }
}

/** 日期是否在 [from, to] 内；空值视为不限制。 */
export function priceValidOn(product, today = new Date().toISOString().slice(0, 10)) {
  const from = String(product.effFrom || '').slice(0, 10)
  const to = String(product.effTo || '').slice(0, 10)
  if (from && from > today) return false
  if (to && to < today) return false
  return true
}

/**
 * 校验一行；返回 { level: 'block'|'warn', code, message } 列表。
 * product: { code, name, status, minDiscount, stdPrice, costPrice, effFrom, effTo }
 */
export function validateLine({ product, qty, discount, today }) {
  const issues = []
  if (!product) return [{ level: 'block', code: 'product-missing', message: '产品不存在' }]
  if (product.status && product.status !== '在售') {
    issues.push({ level: 'block', code: 'not-on-sale', message: `${product.name} 状态为「${product.status}」，禁止报价` })
  }
  if (!priceValidOn(product, today)) {
    issues.push({ level: 'block', code: 'price-expired', message: `${product.name} 价格不在有效期内` })
  }
  if (!(Number(qty) > 0)) issues.push({ level: 'block', code: 'bad-qty', message: '数量必须大于 0' })
  const d = Number(discount)
  if (!(d >= 0.01 && d <= 1)) issues.push({ level: 'block', code: 'bad-discount', message: '折扣需在 0.01~1 之间' })
  const minDisc = Number(product.minDiscount)
  if (Number.isFinite(minDisc) && minDisc > 0 && d < minDisc) {
    issues.push({ level: 'block', code: 'below-floor', message: `${product.name} 折扣 ${(d * 100).toFixed(0)}% 低于最低折扣 ${(minDisc * 100).toFixed(0)}%` })
  }
  if (!(Number(product.costPrice) > 0)) {
    issues.push({ level: 'warn', code: 'no-cost', message: `${product.name} 缺少成本价，毛利不可算` })
  }
  return issues
}

/** 生成报价 DTO。lines 为已计价行；meta 原样带入。 */
export function buildQuoteDto({ lines, meta = {}, warnings = [] }) {
  const totals = computeTotals(lines)
  return {
    ...meta,
    lines,
    totals,
    warnings,
    status: warnings.length ? 'draft-with-warnings' : 'draft',
    generatedAt: new Date().toISOString(),
  }
}
