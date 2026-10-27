import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildQuoteDto, computeLine, computeTotals, priceValidOn, round2, round4, validateLine,
} from '../lib/pricing.js'

describe('计价', () => {
  it('单行：未税单价按 4 位、税额/小计按 2 位', () => {
    const l = computeLine({ stdPrice: 100, costPrice: 60, discount: 0.92, qty: 2, taxRate: 0.13 })
    assert.equal(l.untaxedUnit, 92)
    assert.equal(l.untaxedSubtotal, 184)
    assert.equal(l.tax, 23.92)
    assert.equal(l.grossSubtotal, 207.92)
    assert.equal(l.costSubtotal, 120)
  })

  it('低价产品 4 位精度（0.0344）', () => {
    const l = computeLine({ stdPrice: 0.0344, costPrice: 0.02, discount: 0.95, qty: 100000 })
    assert.equal(l.untaxedUnit, 0.0327)
    assert.equal(l.untaxedSubtotal, 3270)
    assert.equal(l.tax, 425.1)
  })

  it('汇总与毛利', () => {
    const lines = [computeLine({ stdPrice: 1000, costPrice: 600, discount: 0.9, qty: 1 })]
    const t = computeTotals(lines)
    assert.equal(t.untaxedTotal, 900)
    assert.equal(t.taxTotal, 117)
    assert.equal(t.grossTotal, 1017)
    assert.equal(t.profit, 300)
    assert.equal(t.margin, 0.3333)
  })
})

describe('校验', () => {
  const base = { code: 'P1', name: '产品1', status: '在售', minDiscount: 0.85, stdPrice: 100, costPrice: 60, effFrom: '2026-01-01', effTo: '2026-12-31' }
  it('停产/过期/底价/数量均拦截', () => {
    assert.ok(validateLine({ product: { ...base, status: '停产' }, qty: 1, discount: 1 }).some((x) => x.code === 'not-on-sale'))
    assert.ok(validateLine({ product: { ...base, effTo: '2020-01-01' }, qty: 1, discount: 1 }).some((x) => x.code === 'price-expired'))
    assert.ok(validateLine({ product: base, qty: 1, discount: 0.8 }).some((x) => x.code === 'below-floor'))
    assert.ok(validateLine({ product: base, qty: 0, discount: 1 }).some((x) => x.code === 'bad-qty'))
  })
  it('缺成本价只警告', () => {
    const issues = validateLine({ product: { ...base, costPrice: 0 }, qty: 1, discount: 1 })
    assert.equal(issues.find((x) => x.code === 'no-cost')?.level, 'warn')
  })
})

describe('日期与舍入', () => {
  it('价格有效期', () => {
    assert.equal(priceValidOn({ effFrom: '2026-01-01', effTo: '2026-12-31' }, '2026-06-01'), true)
    assert.equal(priceValidOn({ effTo: '2026-05-31' }, '2026-06-01'), false)
  })
  it('舍入', () => {
    assert.equal(round4(0.1 + 0.2), 0.3)
    assert.equal(round2(1.005), 1.01)
  })
})
