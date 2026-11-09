/**
 * 售前数字员工（报价）插件 v0.1。
 *
 * 数据全部在 WPS 多维表，插件只做：
 *   产品检索 → 计价/校验 → 报价落库（报价单/版本/明细）→ Markdown 出单。
 * 不持有主数据，不缓存凭证（凭证仍在 wps365-cli 钥匙串里）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import crypto from 'node:crypto'

import {
  DEFAULTS as CLI_DEFAULTS,
  classifyFailure,
  readAuthStatus,
  resolveCliPath,
  runCliJson,
} from './lib/runner.js'
import {
  DEFAULT_MIN_MARGIN,
  DEFAULT_TAX_RATE,
  buildQuoteDto,
  computeLine,
  round,
  round2,
  validateLine,
} from './lib/pricing.js'
import { resolveTables } from './lib/tables.js'
import { buildQuoteLayout } from './lib/xlsx-layout.js'
import { PRESALES_SKILL, NEW_OPP_PROMPT, NEW_CUSTOMER_PROMPT } from './lib/skill.js'
import { GB_INDUSTRIES } from './lib/industry.js'
import { planSectionWrites } from './lib/section-render.js'
import { buildRfqMail } from './lib/rfq-mail.js'
import * as XLSX from 'xlsx'

export const name = 'presales'
export const inject = ['tools']

const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
})

const SCOPE_DBSHEET = ['kso.dbsheet.readwrite', 'kso.dbsheet.read']

const DEFAULTS = {
  cliPath: '',
  configDir: '',
  timeoutMs: 30_000,
  write: true,
  showCost: true,
  defaultTaxRate: DEFAULT_TAX_RATE,
  minMarginWarn: DEFAULT_MIN_MARGIN,
  outputDir: '',
  templateFolderNode: 'cuHskXQMMJkZ',
  tables: {},
  updateRepos: { cnbm: 'xingkongge/dsh-cnbm-wps365', presales: 'xingkongge/dsh-presales' },
  githubToken: '',
}

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-')
const today = () => new Date().toISOString().slice(0, 10)
const normDate = (v) => String(v || '').replaceAll('/', '-').slice(0, 10)

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const tables = resolveTables(config)

  // 后台静默续期：剩余 < 15 分钟且有 refresh token 时自动刷新
  if (typeof ctx.effect === 'function') ctx.effect(() => {
    const tick = async () => {
      try {
        const cli = resolveCliPath(config)
        if (!cli) return
        const auth = await readAuthStatus(cli, config)
        if (!auth.ok) return
        const d = auth.delegated || {}
        const remain = Number(d.remaining_seconds) || 0
        if (d.has_refresh && (d.status !== 'valid' || remain < 900)) {
          await runCli(cli, ['auth', 'refresh', '--delegated', '-o', 'json'], config)
        }
      } catch { /* 静默 */ }
    }
    const timer = setInterval(tick, 10 * 60 * 1000)
    timer.unref?.()
    setTimeout(tick, 30 * 1000).unref?.()
    return () => clearInterval(timer)
  })

  const register = (def) => ctx.tools.register(def)

  async function ready() {
    const cli = resolveCliPath(config)
    if (!cli) return { error: '❌ 未安装 wps365-cli。安装：curl -fsSL https://open-docs.wpscdn.cn/cli/install.sh | bash' }
    let auth = await readAuthStatus(cli, config)
    if (!auth.ok) return { error: '❌ 无法读取认证状态，请先在 cnbm知识库 面板登录。' }
    if (!auth.delegated.available || auth.delegated.status !== 'valid') {
      // 先用 refresh token 静默续期，续不上才需要人扫码
      if (auth.delegated.has_refresh) {
        const refreshed = await runCli(cli, ['auth', 'refresh', '--delegated', '-o', 'json'], config)
        if (refreshed.ok) auth = await readAuthStatus(cli, config)
      }
    }
    if (!auth.delegated.available || auth.delegated.status !== 'valid') {
      return { error: '🔐 WPS 授权已失效，请到 cnbm知识库 面板重新登录后再试。' }
    }
    const scopes = auth.grantedScopes || []
    if (scopes.length && !SCOPE_DBSHEET.some((s) => scopes.includes(s))) {
      return { error: '⛔ 缺少 kso.dbsheet.readwrite 授权，请重新授权。' }
    }
    return { cli, auth }
  }

  async function list(alias) {
    const t = tables[alias]
    if (!t) throw new Error(`未知表别名：${alias}`)
    const r = runCli(await cliOk(), ['dbsheet', 'record', 'list', t.fileId, String(t.sheetId), '--page-size', '200', '-o', 'json'])
    const res = await r
    if (!res.ok) throw new Error(`${t.label} 读取失败：${res.stderr || res.stdout}`)
    const records = res.json?.data?.records ?? res.json?.records ?? []
    return records.map((x) => ({ ...safeJson(x.fields), _id: x.id }))
  }

  async function cliOk() {
    const r = await ready()
    if (r.error) throw new Error(r.error)
    return r.cli
  }

  let meCache = { at: 0, data: null }
  async function currentUser() {
    if (meCache.data && Date.now() - meCache.at < 5 * 60 * 1000) return meCache.data
    try {
      const cli = await cliOk()
      const r = await runCli(cli, ['user', 'me', '-o', 'json'])
      const d = r.json?.data || {}
      const data = { id: d.id || '', name: d.user_name || '' }
      if (data.name) meCache = { at: Date.now(), data }
      return data
    } catch { return { id: '', name: '' } }
  }

  async function create(alias, rows) {
    if (config.write === false) throw new Error('写操作已禁用（config.write=false）')
    const t = tables[alias]
    const cli = await cliOk()
    const body = rows.map((row) => ({ fields_value: JSON.stringify(row) }))
    const res = await runCli(cli, ['dbsheet', 'record', 'create', t.fileId, String(t.sheetId), '--records-body', JSON.stringify(body), '-o', 'json'])
    if (!res.ok) throw new Error(`${t.label} 写入失败：${res.stderr || res.stdout}`)
    return (res.json?.data?.records ?? res.json?.records ?? []).map((x) => x.id)
  }

  async function updateRecord(alias, id, fields) {
    const t = tables[alias]
    const cli = await cliOk()
    const body = [{ id, fields_value: JSON.stringify(fields) }]
    const res = await runCli(cli, ['dbsheet', 'record', 'update', t.fileId, String(t.sheetId), '--records-body', JSON.stringify(body), '-o', 'json'])
    if (!res.ok) throw new Error(`${t.label} 更新失败：${res.stderr || res.stdout}`)
    return true
  }

  async function deleteRecord(alias, id) {
    const t = tables[alias]
    const cli = await cliOk()
    const res = await runCli(cli, ['dbsheet', 'record', 'delete', t.fileId, String(t.sheetId), '--records', String(id), '-o', 'json'])
    if (!res.ok) throw new Error(`${t.label} 删除失败：${res.stderr || res.stdout}`)
    return true
  }

  async function registerDocument({ quoteNo, version, customerName, opportunityNo, opportunityName, fileName, link }) {
    if (!link) return null
    const [id] = await create('documents', [{
      '产物编号': `${quoteNo}-${version}-XLSX`,
      '标题': `${quoteNo} ${customerName || ''} 报价单`,
      '商机编号': opportunityNo || '',
      '商机名称': opportunityName || '',
      '版本': version || 'V1',
      '文件名': fileName || '',
      '生成时间': today(),
      '溯源': link,
      '类型': '报价单',
      '状态': '已生成',
      '交付状态': '未交付',
    }])
    return id
  }

  function safeJson(s) {
    try { return typeof s === 'string' ? JSON.parse(s) : (s || {}) } catch { return {} }
  }

  function runCli(cli, args) {
    return runCliJson(cli, args, config, {})
  }

  // ── 数据读取 ────────────────────────────────────────────────
  async function loadCatalog() {
    const [products, categories, modules] = await Promise.all([list('products'), list('productCategories'), list('productModules')])
    const catById = new Map(categories.map((c) => [c._id, c['分类名称']]))
    const modulesByProduct = new Map()
    for (const m of modules) {
      const linked = m['所属产品'] || []
      for (const pid of linked) {
        if (!modulesByProduct.has(pid)) modulesByProduct.set(pid, [])
        modulesByProduct.get(pid).push({ name: m['模块名称'], price: Number(m['模块单价不含税']) || 0, default: Boolean(m['是否默认勾选']), sort: Number(m['排序']) || 0 })
      }
    }
    const items = products.map((p) => {
      const l2 = (p['二级分类'] || [])[0]
      const l1 = (p['一级分类'] || [])[0]
      return {
        id: p._id,
        code: p['产品编码'],
        name: p['产品名称'],
        l1: catById.get(l1) || '',
        l2: catById.get(l2) || '',
        brand: p['品牌'] || '',
        model: p['型号'] || '',
        spec: p['规格'] || '',
        unit: p['单位'] || '',
        status: p['状态'] || '',
        strategy: p['销售策略'] || '',
        stdPrice: Number(p['标准价不含税']) || 0,
        costPrice: Number(p['成本价不含税']) || 0,
        taxRate: Number(p['税率']) || config.defaultTaxRate,
        grossPrice: Number(p['含税价参考']) || 0,
        minDiscount: Number(p['最低折扣']) || 0,
        effFrom: normDate(p['价格生效起']),
        effTo: normDate(p['价格生效止']),
        mode: p['报价模式'] || '简易',
        modules: (modulesByProduct.get(p._id) || []).sort((a, b) => a.sort - b.sort),
      }
    })
    return items
  }

  function findProduct(catalog, key) {
    const k = String(key || '').trim()
    if (!k) return { error: '产品为空' }
    const exact = catalog.filter((p) => p.code === k || p.name === k)
    if (exact.length === 1) return { product: exact[0] }
    const fuzzy = catalog.filter((p) => p.code.includes(k) || p.name.includes(k))
    if (fuzzy.length === 1) return { product: fuzzy[0] }
    if (fuzzy.length === 0) return { error: `未找到产品「${k}」` }
    return { candidates: fuzzy.slice(0, 8).map((p) => `${p.code} ${p.name}`) }
  }

  function isQuotable(p) {
    return p.status === '在售' && (!p.effTo || p.effTo >= today()) && (!p.effFrom || p.effFrom <= today())
  }

  /** 把产品按模块拆成多行：产品行 + 选中的模块行（未指定则取默认勾选模块）。 */
  function expandProduct(p, { qty, discount, modules, section } = {}) {
    const out = []
    const base = { code: p.code, name: p.name, spec: p.spec, brand: p.brand, model: p.model, unit: p.unit, qty, discount, stdPrice: p.stdPrice, costPrice: p.costPrice, taxRate: p.taxRate, section: section || '', category: p.l2, remark: '' }
    out.push(base)
    const chosen = Array.isArray(modules) && modules.length
      ? p.modules.filter((m) => modules.includes(m.name))
      : p.modules.filter((m) => m.default)
    for (const m of chosen) {
      out.push({ ...base, name: `${p.name} - ${m.name}`, stdPrice: m.price, costPrice: 0, remark: '模块' })
    }
    return out
  }

  /** 由 [{code,name,qty,discount,modules}] 生成报价行（含模块拆行与校验）。 */
  async function buildLinesFromItems(inputItems, section = '一、产品报价') {
    const catalog = await loadCatalog()
    const lines = []
    const violations = []
    for (const it of inputItems || []) {
      const found = findProduct(catalog, it.code || it.name)
      if (found.error) { violations.push({ level: 'block', message: `${it.code || it.name}：${found.error}` }); continue }
      if (found.candidates) { violations.push({ level: 'block', message: `「${it.code || it.name}」匹配到多个产品` }); continue }
      const p = found.product
      const qty = Number(it.qty) || 0
      const discount = Number(it.discount) || 1
      for (const e of expandProduct(p, { qty, discount, modules: it.modules, section })) {
        for (const v of validateLine({ product: { ...p, name: e.name, stdPrice: e.stdPrice, costPrice: e.costPrice }, qty, discount, today: today() })) {
          if (v.level === 'block') violations.push({ product: p.code, ...v })
        }
        const money = computeLine({ stdPrice: e.stdPrice, costPrice: e.costPrice, discount, qty, taxRate: e.taxRate })
        lines.push({ lineNo: lines.length + 1, code: e.code, name: e.name, spec: e.spec, brand: e.brand, model: e.model, unit: e.unit, qty, discount, stdPrice: e.stdPrice, ...money, section: e.section, remark: e.remark, category: e.category })
      }
    }
    return { lines, violations }
  }

  function diffLines(prev, next) {
    const key = (l) => `${l.code}|${l.name}`
    const pm = new Map(prev.map((l) => [key(l), l]))
    const nm = new Map(next.map((l) => [key(l), l]))
    const out = []
    for (const [k, l] of nm) {
      const p = pm.get(k)
      if (!p) { out.push(`新增 ${l.name} ×${l.qty}`); continue }
      if (p.qty !== l.qty) out.push(`${l.name} 数量 ${p.qty}→${l.qty}`)
      if (p.discount !== l.discount) out.push(`${l.name} 折扣 ${(p.discount * 100).toFixed(0)}%→${(l.discount * 100).toFixed(0)}%`)
      if (p.stdPrice !== l.stdPrice) out.push(`${l.name} 单价 ${p.stdPrice}→${l.stdPrice}`)
    }
    for (const [k, l] of pm) if (!nm.has(k)) out.push(`移除 ${l.name}`)
    return out
  }

  // ── 工具 ────────────────────────────────────────────────────
  // ── 商机（数字售前内） ──────────────────────────────────────
  const OPP_STAGES = ['线索阶段', '初步沟通', '需求沟通', '方案报价', '商务谈判', '招标阶段', '暂停阶段', '放弃', '赢单', '丢单', '作废']

  async function nextOppNo() {
    const rows = await list('opportunities')
    const year = new Date().getFullYear()
    const max = rows.reduce((m, r) => {
      const mm = /^OPP-(\d{4})-(\d+)$/.exec(r['商机编号'] || '')
      return mm && Number(mm[1]) === year ? Math.max(m, Number(mm[2])) : m
    }, 0)
    return `OPP-${year}-${String(max + 1).padStart(4, '0')}`
  }

  async function logOppChange({ oppId, oppNo, field, oldValue, newValue, reason, by }) {
    const [id] = await create('oppChanges', [{
      '变更编号': `${oppNo}-${Date.now()}`,
      '商机': [oppId],
      '变更时间': today(),
      '变更人': by || '',
      '字段': field,
      '原值': oldValue == null ? '' : String(oldValue),
      '新值': newValue == null ? '' : String(newValue),
      '原因': reason || '',
    }])
    return id
  }

  function oppFieldAliases() {
    return {
      name: '商机名称', customerNo: '客户编号', customerName: '客户名称',
      amount: '商机金额万元', stage: '阶段', expected: '预计落单时间', intro: '简介',
      source: '来源',
      contact: '联系人', phone: '联系电话', sellerName: '销售姓名', ownerName: '售前姓名',
      winRate: '赢单率',
    }
  }

  register({
    name: 'opp_list',
    description: '商机列表：按阶段/关键字过滤，返回编号、名称、客户、金额、阶段、预计落单。',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: '阶段筛选，如 方案报价' },
        keyword: { type: 'string', description: '商机名称/客户/编号关键字' },
        limit: { type: 'number', description: '默认 20' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      let rows = await list('opportunities')
      if (args.stage) rows = rows.filter((r) => r['阶段'] === args.stage)
      const kw = String(args.keyword || '').toLowerCase()
      if (kw) rows = rows.filter((r) => `${r['商机编号']} ${r['商机名称']} ${r['客户名称']}`.toLowerCase().includes(kw))
      const limit = Math.min(Number(args.limit) || 20, 100)
      if (!rows.length) return '没有匹配的商机。'
      return rows.slice(-limit).reverse().map((r) => `${r['商机编号']} · ${r['商机名称']} · ${r['客户名称'] || '-'} · ${r['阶段']} · ${r['商机金额万元'] || 0} 万 · 预计 ${String(r['预计落单时间'] || '-').slice(0, 10)}`).join('\n')
    },
  })

  register({
    name: 'opp_get',
    description: '商机详情：基本信息 + 跟进记录 + 变更记录。',
    parameters: { type: 'object', properties: { no: { type: 'string', description: '商机编号' } }, required: ['no'] },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const rows = await list('opportunities')
      const r = rows.find((x) => x['商机编号'] === args.no)
      if (!r) return `未找到商机 ${args.no}`
      const [followups, changes] = await Promise.all([list('oppFollowups'), list('oppChanges')])
      const fs = followups.filter((f) => (f['商机'] || []).includes(r._id)).sort((a, b) => String(b['跟进日期']).localeCompare(String(a['跟进日期'])))
      const cs = changes.filter((c) => (c['商机'] || []).includes(r._id)).sort((a, b) => String(b['变更时间']).localeCompare(String(a['变更时间'])))
      return [
        `## ${r['商机编号']} ${r['商机名称']}`,
        `客户：${r['客户名称'] || '-'} ｜ 阶段：${r['阶段']} ｜ 金额：${r['商机金额万元'] || 0} 万 ｜ 赢单率：${r['赢单率'] == null ? '-' : (Number(r['赢单率']) * 100).toFixed(0) + '%'}`,
        `预计落单：${String(r['预计落单时间'] || '-').slice(0, 10)} ｜ 最后跟进：${String(r['最后跟进时间'] || '-').slice(0, 10)} ｜ 来源：${r['来源'] || '-'}`,
        r['简介'] ? `简介：${r['简介']}` : '',
        `跟进记录（${fs.length}）：`,
        ...fs.slice(0, 5).map((f) => `- ${String(f['跟进日期'] || '').slice(0, 10)} ${f['方式'] || ''} ${f['跟进人'] || ''}：${String(f['内容'] || '').slice(0, 60)}`),
        `变更记录（${cs.length}）：`,
        ...cs.slice(0, 5).map((c) => `- ${String(c['变更时间'] || '').slice(0, 10)} ${c['字段']}：${c['原值']} → ${c['新值']}`),
      ].filter(Boolean).join('\n')
    },
  })

  async function nextCustomerNo() {
    const rows = await list('customers')
    const year = new Date().getFullYear()
    let max = 0
    for (const r of rows) {
      const m = String(r['客户编号'] || '').match(/C-(\d{4})-(\d+)/)
      if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]))
    }
    return `C-${year}-${String(max + 1).padStart(4, '0')}`
  }

  register({
    name: 'customer_create',
    description: '新建客户（人工确认后调用）：自动生成 C-YYYY-NNNN，可带工商信息来源。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, region: { type: 'string' }, industry: { type: 'string', description: '行业分类（GB/T 4754-2017 门类/大类）' }, industryCategory: { type: 'string' },
        legal: { type: 'string' }, capital: { type: 'string' }, founded: { type: 'string' }, address: { type: 'string' },
        intro: { type: 'string' },
        source: { type: 'string', description: '信息来源，如 企查查' }, sourceUrl: { type: 'string' }, creator: { type: 'string' },
      },
      required: ['name'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const no = await nextCustomerNo()
      const me = await currentUser()
      const row = {
        '客户编号': no, '客户名称': args.name, '省市': args.region || '',
        '行业分类': args.industryCategory || args.industry || '', '法定代表人': args.legal || '',
        '注册资本': args.capital || '', '成立时间': args.founded || '', '地址': args.address || '',
        '客户简介': args.intro || '', '创建人': args.creator || me.name || '', '状态': '正常',
        '信息来源': args.source || '', '来源链接': args.sourceUrl || '',
      }
      const clean = {}
      for (const [k, v] of Object.entries(row)) { if (v !== null && v !== undefined && v !== '') clean[k] = v }
      const [id] = await create('customers', [clean])
      return `✅ 已新建客户 ${no}（${args.name}）`
    },
  })

  register({
    name: 'opp_create',
    description: '新建商机：自动生成 OPP-YYYY-NNNN，默认阶段=线索阶段，并写一条「新建」变更记录。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, customerNo: { type: 'string' }, customerName: { type: 'string' },
        amount: { type: 'number', description: '万元' }, stage: { type: 'string' },
        expected: { type: 'string', description: 'YYYY-MM-DD' }, source: { type: 'string' },
        industry: { type: 'string', description: '行业分类（GB/T 4754-2017 门类/大类）' }, industryCategory: { type: 'string' },
        contact: { type: 'string' }, phone: { type: 'string' }, intro: { type: 'string' },
        sellerName: { type: 'string' }, ownerName: { type: 'string' },
      },
      required: ['name'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const no = await nextOppNo()
      const stage = args.stage || '线索阶段'
      const [id] = await create('opportunities', [{
        '商机编号': no, '商机名称': args.name, '客户编号': args.customerNo || '', '客户名称': args.customerName || '',
        '商机金额万元': Number(args.amount) || 0, '阶段': stage, '预计落单时间': args.expected || '',
        '来源': args.source || '主动开发',
        '联系人': args.contact || '', '联系电话': args.phone || '', '简介': args.intro || '',
        '销售姓名': args.sellerName || '', '售前姓名': args.ownerName || '', '赢单率': 0.1,
      }])
      await logOppChange({ oppId: id, oppNo: no, field: '新建', oldValue: '', newValue: stage, reason: '新建商机', by: args.ownerName })
      return `✅ 已新建商机 ${no}（${args.name}），阶段 ${stage}`
    },
  })

  register({
    name: 'opp_update',
    description: '更新商机字段（自动记录变更：字段/原值/新值/原因）。',
    parameters: {
      type: 'object',
      properties: {
        no: { type: 'string' },
        reason: { type: 'string' },
        fields: { type: 'object', description: '要改的字段，如 { amount: 560, expected: "2026-12-05", intro: "..." }' },
      },
      required: ['no', 'fields'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const rows = await list('opportunities')
      const r = rows.find((x) => x['商机编号'] === args.no)
      if (!r) return `未找到商机 ${args.no}`
      const alias = oppFieldAliases()
      const patch = {}
      const changes = []
      for (const [k, v] of Object.entries(args.fields || {})) {
        const field = alias[k]
        if (!field) continue
        if (k === 'stage' && !OPP_STAGES.includes(v)) return `阶段必须是：${OPP_STAGES.join('、')}`
        const old = r[field]
        if (String(old ?? '') === String(v ?? '')) continue
        patch[field] = v
        changes.push({ field, old, val: v })
      }
      if (!Object.keys(patch).length) return '没有需要更新的字段。'
      await updateRecord('opportunities', r._id, patch)
      for (const c of changes) await logOppChange({ oppId: r._id, oppNo: args.no, field: c.field, oldValue: c.old, newValue: c.val, reason: args.reason, by: '' })
      return `✅ 已更新 ${args.no}：` + changes.map((c) => `${c.field} ${c.old ?? '-'}→${c.val}`).join('；')
    },
  })

  register({
    name: 'opp_stage',
    description: '推进商机阶段：校验 11 个阶段，写变更记录，返回新阶段。',
    parameters: {
      type: 'object',
      properties: {
        no: { type: 'string' }, stage: { type: 'string' }, reason: { type: 'string' }, by: { type: 'string' },
      },
      required: ['no', 'stage'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      if (!OPP_STAGES.includes(args.stage)) return `阶段必须是：${OPP_STAGES.join('、')}`
      const rows = await list('opportunities')
      const r = rows.find((x) => x['商机编号'] === args.no)
      if (!r) return `未找到商机 ${args.no}`
      if (r['阶段'] === args.stage) return `商机 ${args.no} 已是「${args.stage}」`
      await updateRecord('opportunities', r._id, { '阶段': args.stage })
      await logOppChange({ oppId: r._id, oppNo: args.no, field: '阶段', oldValue: r['阶段'], newValue: args.stage, reason: args.reason, by: args.by })
      return `✅ ${args.no} 阶段：${r['阶段']} → ${args.stage}`
    },
  })

  register({
    name: 'opp_followup',
    description: '登记商机跟进记录，并回写商机的最后跟进时间。',
    parameters: {
      type: 'object',
      properties: {
        no: { type: 'string' }, date: { type: 'string' }, person: { type: 'string' },
        way: { type: 'string' }, content: { type: 'string' }, next: { type: 'string' }, nextDate: { type: 'string' },
      },
      required: ['no', 'content'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const rows = await list('opportunities')
      const r = rows.find((x) => x['商机编号'] === args.no)
      if (!r) return `未找到商机 ${args.no}`
      const d = args.date || today()
      await create('oppFollowups', [{
        '跟进编号': `${args.no}-F${Date.now()}`, '商机': [r._id], '跟进日期': d,
        '跟进人': args.person || '', '方式': args.way || '其他', '内容': args.content || '',
        '下一步': args.next || '', '下次跟进': args.nextDate || '',
      }])
      await updateRecord('opportunities', r._id, { '最后跟进时间': d })
      return `✅ 已登记 ${args.no} 跟进（${d}），最后跟进时间已更新`
    },
  })

  register({
    name: 'opp_board',
    description: '商机看板汇总：阶段漏斗、行业分布、来源分布、金额 Top。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    async execute() {
      const rows = await list('opportunities')
      const total = rows.length
      const sum = rows.reduce((s, r) => s + (Number(r['商机金额万元']) || 0), 0)
      const by = (key) => {
        const m = new Map()
        for (const r of rows) {
          const k = r[key] || '未填'
          const v = m.get(k) || { n: 0, amt: 0 }
          v.n += 1; v.amt += Number(r['商机金额万元']) || 0
          m.set(k, v)
        }
        return [...m.entries()].sort((a, b) => b[1].amt - a[1].amt)
      }
      const active = rows.filter((r) => !['赢单', '丢单', '放弃', '作废'].includes(r['阶段'])).length
      const won = rows.filter((r) => r['阶段'] === '赢单').length
      const lines = [
        `## 商机看板`,
        `总数 ${total} ｜ 总金额 ${sum.toFixed(0)} 万 ｜ 进行中 ${active} ｜ 赢单 ${won} ｜ 赢单率 ${total ? ((won / total) * 100).toFixed(0) : 0}%`,
        '',
        '### 阶段分布',
        ...by('阶段').map(([k, v]) => `- ${k}：${v.n} 个 / ${v.amt.toFixed(0)} 万`),
        '',
        '### 行业（一级）',
        '',
        '### 来源',
        ...by('来源').map(([k, v]) => `- ${k}：${v.n} 个`),
        '',
        '### 金额 Top 5',
        ...rows.slice().sort((a, b) => (Number(b['商机金额万元']) || 0) - (Number(a['商机金额万元']) || 0)).slice(0, 5)
          .map((r, i) => `${i + 1}. ${r['商机名称']} · ${r['客户名称'] || '-'} · ${r['商机金额万元']} 万 · ${r['阶段']} · ${r['售前姓名'] || '-'}`),
      ]
      return lines.join('\n')
    },
  })

  register({
    name: 'quote_status',
    description: '报价插件环境自检：CLI/登录、scope、11 张业务表连通性、可用模板。',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    async execute() {
      const r = await ready()
      if (r.error) return r.error
      const lines = ['## 报价插件状态', '', `CLI：${r.cli}`, `已授予 scope：${(r.auth.grantedScopes || []).join(', ') || '（空）'}`]
      for (const alias of Object.keys(tables)) {
        try {
          const rows = await list(alias)
          lines.push(`- ${tables[alias].label}（${alias}）：${rows.length} 条`)
        } catch (e) {
          lines.push(`- ${tables[alias].label}（${alias}）：读取失败 — ${String(e.message).slice(0, 120)}`)
        }
      }
      return lines.join('\n')
    },
  })

  register({
    name: 'quote_catalog_search',
    description: '按关键字/分类检索产品清单（默认只在售且价格有效），返回产品编码、名称、规格、单位、未税价、最低折扣。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '产品名称或编码片段' },
        category: { type: 'string', description: '一级或二级分类名称' },
        limit: { type: 'number', description: '返回条数，默认 15' },
        includeUnquotable: { type: 'boolean', description: '包含停产/过期产品' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const catalog = await loadCatalog()
      const kw = String(args.keyword || '').toLowerCase()
      let rows = catalog.filter((p) => args.includeUnquotable || isQuotable(p))
      if (kw) rows = rows.filter((p) => `${p.code} ${p.name} ${p.brand} ${p.model}`.toLowerCase().includes(kw))
      if (args.category) rows = rows.filter((p) => p.l1 === args.category || p.l2 === args.category)
      if (!rows.length) return '没有匹配的产品。可放宽关键字或检查「产品清单」。'
      const limit = Math.min(Number(args.limit) || 15, 50)
      return rows.slice(0, limit).map((p, i) => [
        `${i + 1}. ${p.name}（${p.code}）`,
        `   ${p.l1} / ${p.l2} · ${p.unit} · 状态 ${p.status}`,
        `   未税价 ${fmt(p.stdPrice)} · 最低折扣 ${(p.minDiscount * 100).toFixed(0)}%${config.showCost ? ` · 成本 ${fmt(p.costPrice)}` : ''}`,
      ].join('\n')).join('\n\n')
    },
  })

  register({
    name: 'quote_build',
    description: '计价与校验（不落库）：输入产品与数量/折扣，返回未税/税额/含税合计、毛利、违规项与建议模板。',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string' },
        opportunityNo: { type: 'string' },
        items: {
          type: 'array',
          description: '报价明细：[{ code|name, qty, discount?, section? }]',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' }, name: { type: 'string' },
              qty: { type: 'number' }, discount: { type: 'number' },
              section: { type: 'string' },
            },
          },
        },
      },
      required: ['items'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const catalog = await loadCatalog()
      const inputItems = Array.isArray(args.items) ? args.items : []
      if (!inputItems.length) return '缺少 items。'
      const lines = []
      const violations = []
      const warnings = []
      for (const [idx, it] of inputItems.entries()) {
        const found = findProduct(catalog, it.code || it.name)
        if (found.error) { violations.push({ level: 'block', code: 'product-missing', message: `${it.code || it.name}：${found.error}` }); continue }
        if (found.candidates) { violations.push({ level: 'block', code: 'ambiguous', message: `「${it.code || it.name}」匹配到多个产品：${found.candidates.join('、')}` }); continue }
        const p = found.product
        const discount = Number(it.discount ?? 1)
        const qty = Number(it.qty ?? 1)
        const expanded = expandProduct(p, { qty, discount, modules: it.modules, section: it.section })
        for (const e of expanded) {
          const issues = validateLine({ product: { ...p, name: e.name, stdPrice: e.stdPrice, costPrice: e.costPrice }, qty, discount, today: today() })
          for (const x of issues) (x.level === 'block' ? violations : warnings).push({ ...x, product: p.code })
          const money = computeLine({ stdPrice: e.stdPrice, costPrice: e.costPrice, discount, qty, taxRate: e.taxRate })
          lines.push({
            lineNo: lines.length + 1, productId: p.id, code: e.code, name: e.name, spec: e.spec,
            brand: e.brand, model: e.model, unit: e.unit, qty, discount,
            stdPrice: e.stdPrice, ...money, section: e.section, remark: e.remark, category: e.category,
          })
        }
      }
      const dto = buildQuoteDto({
        lines,
        meta: { customerName: args.customerName || '', opportunityNo: args.opportunityNo || '' },
        warnings,
      })
      dto.violations = violations
      // 模板建议
      const templates = await list('quoteTemplates')
      const cats = new Set(lines.map((l) => l.category).filter(Boolean))
      const scored = templates.filter((t) => t['启用状态'] === '启用').map((t) => {
        const hit = (t['适用二级分类'] || []).filter((c) => cats.has(c)).length
        return { name: t['模板名称'], type: t['模板类型'], fileId: t['文件ID'], default: Boolean(t['默认模板']), hit }
      }).sort((a, b) => (b.hit - a.hit) || (b.default - a.default))
      dto.template = scored[0]?.name || ''
      const linesOut = [
        `客户：${dto.customerName || '-'}${dto.opportunityNo ? ` · 商机 ${dto.opportunityNo}` : ''}`,
        `建议模板：${dto.template || '（无匹配，用默认）'}`,
        '',
        ...lines.map((l) => `${l.lineNo}. ${l.name} × ${l.qty}${l.unit} 折扣 ${(l.discount * 100).toFixed(0)}% = 未税 ${fmt(l.untaxedSubtotal)} / 税 ${fmt(l.tax)} / 含税 ${fmt(l.grossSubtotal)}`),
        '',
        `未税合计 ${fmt(dto.totals.untaxedTotal)} · 税额 ${fmt(dto.totals.taxTotal)} · 含税合计 ${fmt(dto.totals.grossTotal)}`,
        `毛利 ${fmt(dto.totals.profit)} · 毛利率 ${dto.totals.margin == null ? '-' : (dto.totals.margin * 100).toFixed(2) + '%'}`,
      ]
      if (violations.length) linesOut.push('', '⛔ 违规（必须修正）：', ...violations.map((v) => `- ${v.message}`))
      if (warnings.length) linesOut.push('', '⚠️ 提醒：', ...warnings.map((v) => `- ${v.message}`))
      linesOut.push('', '---', 'DTO JSON：', JSON.stringify(dto))
      return linesOut.join('\n')
    },
  })

  register({
    name: 'quote_save',
    description: '把 quote_build 的结果落库：生成报价单号、报价单+版本V1+明细（含快照），返回单号与记录 ID。',
    parameters: {
      type: 'object',
      properties: {
        dto: { type: 'object', description: 'quote_build 返回的 DTO（带 lines/totals）' },
        template: { type: 'string', description: '模板名称，默认取 DTO.template' },
        validityDays: { type: 'number', description: '有效期天数，默认 30' },
      },
      required: ['dto'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const dto = args.dto
      if (!dto || !Array.isArray(dto.lines) || !dto.totals) return '缺少 dto（请先调用 quote_build）。'
      if ((dto.violations || []).some((v) => v.level === 'block')) return '⛔ 存在违规项，不能落库：\n' + dto.violations.map((v) => '- ' + v.message).join('\n')
      const quotes = await list('quotes')
      const year = new Date().getFullYear()
      const max = quotes.reduce((m, q) => {
        const mm = /^BJ-(\d{4})-(\d+)$/.exec(q['报价单号'] || '')
        return mm && Number(mm[1]) === year ? Math.max(m, Number(mm[2])) : m
      }, 0)
      const quoteNo = `BJ-${year}-${String(max + 1).padStart(4, '0')}`
      const key = crypto.createHash('sha1').update(JSON.stringify({ c: dto.customerName || '', items: dto.lines.map((l) => [l.code, l.qty, l.discount]) })).digest('hex').slice(0, 16)
      const exist = quotes.find((q) => q['幂等键'] === key && q['状态'] !== '作废')
      if (exist) return `已存在相同报价（幂等命中）：${exist['报价单号']}（状态 ${exist['状态']}）`
      const version = 'V1'
      const versionKey = `${quoteNo}-${version}`
      const validityDays = Number(args.validityDays) || 30
      const validUntil = new Date(Date.now() + validityDays * 86400000).toISOString().slice(0, 10)
      const tplName = args.template || dto.template || '简易报价模板'
      const [quoteId] = await create('quotes', [{
        '报价单号': quoteNo,
        '商机编号': dto.opportunityNo || '',
        '商机名称': dto.opportunityName || '',
        '客户编号': dto.customerNo || '',
        '客户名称': dto.customerName || '',
        '模板': tplName,
        '当前版本': version,
        '状态': '草稿',
        '不含税合计': dto.totals.untaxedTotal,
        '税额合计': dto.totals.taxTotal,
        '含税合计': dto.totals.grossTotal,
        '毛利率': dto.totals.margin ?? '',
        '价目表版本': 'v1',
        '幂等键': key,
      }])
      const [versionId] = await create('quoteVersions', [{
        '版本标识': versionKey,
        '报价单': [quoteId],
        '报价单号': quoteNo,
        '版本号': 1,
        '状态': '草稿',
        '模板': tplName,
        '提交时间': today(),
        '有效期至': validUntil,
        '不含税合计': dto.totals.untaxedTotal,
        '税额合计': dto.totals.taxTotal,
        '含税合计': dto.totals.grossTotal,
        '成本合计': dto.totals.costTotal,
        '毛利额': dto.totals.profit,
        '毛利率': dto.totals.margin ?? '',
        '变更说明': '',
      }])
      const rows = dto.lines.map((l) => ({
        '行标识': `${versionKey}-${String(l.lineNo).padStart(2, '0')}`,
        '报价版本': [versionId],
        '版本标识': versionKey,
        '序号': l.lineNo,
        '分节': l.section || '一、产品报价',
        '产品编码': l.code,
        '产品名称': l.name,
        '规格': l.spec,
        '品牌': l.brand,
        '型号': l.model,
        '单位': l.unit,
        '数量': l.qty,
        '标准未税单价': l.stdPrice,
        '折扣': l.discount,
        '不含税单价': l.untaxedUnit,
        '税率': l.taxRate,
        '税额': l.tax,
        '含税单价': l.grossUnit,
        '不含税小计': l.untaxedSubtotal,
        '含税小计': l.grossSubtotal,
        '备注': l.remark || '',
      }))
      const itemIds = await create('quoteItems', rows)
      let link = ''
      try {
        const rendered = await renderByTemplate(dto, { quoteNo, version: 'V1', date: today(), customerName: dto.customerName || '', validUntil }, tplName)
        link = rendered.link || ''
        if (link) await updateRecord('quotes', quoteId, { '文件链接': link })
        await registerDocument({ quoteNo, version: 'V1', customerName: dto.customerName, opportunityNo: dto.opportunityNo, fileName: rendered.name, link })
      } catch { /* 出单失败不影响落库 */ }
      return [
        `✅ 已生成报价单 ${quoteNo}（${version}）`,
        `报价单记录：${quoteId}`,
        `版本记录：${versionId}（明细 ${itemIds.length} 行）`,
        `含税合计：${fmt(dto.totals.grossTotal)}`,
        link ? `Excel：${link}` : '（Excel 生成失败，可用 quote_render_xlsx 重试）',
      ].join('\n')
    },
  })

  register({
    name: 'quote_revise',
    description: '基于已有报价单生成新版本（V2/V3…）：传完整明细（可改价/改量/增删），自动记录变更并重出 Excel。',
    parameters: {
      type: 'object',
      properties: {
        quoteNo: { type: 'string', description: '原报价单号，如 BJ-2026-0004' },
        items: {
          type: 'array',
          description: '新版本完整明细：[{ code|name, qty, discount?, modules? }]',
          items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, qty: { type: 'number' }, discount: { type: 'number' } } },
        },
        note: { type: 'string', description: '变更说明（可选，自动变更记录会拼在前面）' },
      },
      required: ['quoteNo', 'items'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const quoteNo = String(args.quoteNo || '')
      const [quotes, versions] = await Promise.all([list('quotes'), list('quoteVersions')])
      const q = quotes.find((x) => x['报价单号'] === quoteNo)
      if (!q) return `未找到报价单 ${quoteNo}`
      const vs = versions.filter((v) => (v['报价单'] || []).includes(q._id)).sort((a, b) => Number(a['版本号']) - Number(b['版本号']))
      const last = vs[vs.length - 1]
      const nextNo = (Number(last?.['版本号']) || 1) + 1
      const prevDto = await loadQuoteDto(quoteNo)
      const { lines, violations } = await buildLinesFromItems(args.items)
      if (violations.length) return '⛔ 存在违规项：\n' + violations.map((v) => '- ' + v.message).join('\n')
      const dto = buildQuoteDto({ lines, meta: { customerName: q['客户名称'] || '', customerNo: q['客户编号'] || '', opportunityNo: q['商机编号'] || '', opportunityName: q['商机名称'] || '' } })
      const changes = diffLines(prevDto.lines, lines)
      const changeText = [changes.join('；'), args.note || ''].filter(Boolean).join('；') || '重出报价单'
      const version = `V${nextNo}`
      const [versionId] = await create('quoteVersions', [{
        '版本标识': `${quoteNo}-${version}`, '报价单': [q._id], '报价单号': quoteNo, '版本号': nextNo,
        '状态': '草稿', '模板': q['模板'] || '', '提交时间': today(), '有效期至': last?.['有效期至'] || '',
        '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal, '含税合计': dto.totals.grossTotal,
        '成本合计': dto.totals.costTotal, '毛利额': dto.totals.profit, '毛利率': dto.totals.margin ?? '', '变更说明': changeText,
      }])
      await create('quoteItems', lines.map((l) => ({
        '行标识': `${quoteNo}-${version}-${String(l.lineNo).padStart(2, '0')}`, '报价版本': [versionId], '版本标识': `${quoteNo}-${version}`,
        '序号': l.lineNo, '分节': l.section || '一、产品报价', '产品编码': l.code, '产品名称': l.name,
        '规格': l.spec, '品牌': l.brand, '型号': l.model, '单位': l.unit, '数量': l.qty,
        '标准未税单价': l.stdPrice, '折扣': l.discount, '不含税单价': l.untaxedUnit, '税率': l.taxRate,
        '税额': l.tax, '含税单价': l.grossUnit, '不含税小计': l.untaxedSubtotal, '含税小计': l.grossSubtotal, '备注': l.remark || '',
        '行类型': l.lineType || '目录产品', '询价编号': l.rfqNo || '', '价格状态': l.priceStatus || '已定价',
      })))
      let link = ''
      try {
        const rendered = await renderByTemplate(dto, { quoteNo, version, date: today(), customerName: dto.customerName, validUntil: last?.['有效期至'] || '' }, q['模板'])
        link = rendered.link || ''
        await updateRecord('quotes', q._id, {
          '当前版本': version, '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal,
          '含税合计': dto.totals.grossTotal, '毛利率': dto.totals.margin ?? '', '文件链接': link,
        })
        await registerDocument({ quoteNo, version, customerName: dto.customerName, opportunityNo: dto.opportunityNo, opportunityName: dto.opportunityName, fileName: rendered.name, link })
      } catch { /* 出单失败不影响版本落库 */ }
      return [
        `✅ 已生成 ${quoteNo} ${version}`,
        `变更：${changeText}`,
        `含税合计：${fmt(dto.totals.grossTotal)}`,
        link ? `Excel：${link}` : '（Excel 生成失败，可用 quote_render_xlsx 重试）',
      ].join('\n')
    },
  })

  register({
    name: 'quote_list',
    description: '列出最近报价单及其版本。',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const [quotes, versions] = await Promise.all([list('quotes'), list('quoteVersions')])
      const limit = Math.min(Number(args.limit) || 10, 50)
      const rows = quotes.slice(-limit).reverse()
      return rows.map((q) => {
        const vs = versions.filter((v) => (v['报价单'] || []).includes(q._id))
        return `${q['报价单号']} · ${q['客户名称'] || '-'} · 含税 ${fmt(q['含税合计'])} · ${q['状态']} · ${q['当前版本']}（${vs.length} 个版本）`
      }).join('\n') || '暂无报价单'
    },
  })



  // ── xlsx 出单：在 WPS 报价单文件夹里生成 Excel ─────────────
  const SPACE = 'qdobkWP'
  const RENDER_PARENT = config.renderParentNode || 'ccGVaCOcsQ1N'

  async function wikiChildren(node) {
    const cli = await cliOk()
    const res = await runCli(cli, ['api', 'get', `/v7/wiki/spaces/${SPACE}/files/${node}/children`, '--query', 'page_size=100', '-o', 'json'])
    if (!res.ok) throw new Error(`读取目录失败：${res.stderr || res.stdout}`)
    return res.json?.data?.items || []
  }

  async function ensureRenderFolder() {
    const items = await wikiChildren(RENDER_PARENT)
    const hit = items.find((x) => x.type === 'folder' && x.name === '报价单')
    if (hit) return hit.id
    const cli = await cliOk()
    const meta = await runCli(cli, ['api', 'get', `/v7/files/${RENDER_PARENT}/meta`, '-o', 'json'])
    const parentReal = meta.json?.data?.id
    if (!parentReal) throw new Error('无法解析报价管理目录')
    const created = await runCli(cli, ['drive', 'file', 'create', SPACE, parentReal, '--name', '报价单', '--file-type', 'folder', '-o', 'json'])
    if (!created.ok) throw new Error(`创建报价单目录失败：${created.stderr || created.stdout}`)
    const again = await wikiChildren(RENDER_PARENT)
    const folder = again.find((x) => x.type === 'folder' && x.name === '报价单')
    if (!folder) throw new Error('创建报价单目录后未找到')
    return folder.id
  }

  async function renderQuoteXlsx(dto, meta = {}) {
    const cli = await cliOk()
    const folderNode = await ensureRenderFolder()
    const folderMeta = await runCli(cli, ['api', 'get', `/v7/files/${folderNode}/meta`, '-o', 'json'])
    const folderReal = folderMeta.json?.data?.id
    if (!folderReal) throw new Error('无法解析报价单目录')
    const safeCustomer = String(dto.customerName || meta.customerName || '客户').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
    const vSuffix = meta.version && meta.version !== 'V1' ? `_${meta.version}` : ''
    const name = `${meta.quoteNo || 'DRAFT'}${vSuffix}_${safeCustomer}_报价单.xlsx`
    const created = await runCli(cli, ['drive', 'file', 'create', SPACE, folderReal, '--name', name, '--file-type', 'file', '-o', 'json'])
    if (!created.ok) throw new Error(`创建报价单文件失败：${created.stderr || created.stdout}`)
    const fileId = created.json?.data?.id
    if (!fileId) throw new Error('创建报价单文件失败：无 file id')
    const sheets = await runCli(cli, ['api', 'get', `/v7/sheets/${fileId}/worksheets`, '-o', 'json'])
    const sid = sheets.json?.data?.sheets?.[0]?.sheet_id
    if (!sid) throw new Error('读取工作表失败')
    await runCli(cli, ['api', 'post', `/v7/sheets/${fileId}/worksheets/${sid}/update`, '--data', JSON.stringify({ name: '报价单' }), '-o', 'json'])
    const layout = buildQuoteLayout(dto, meta)
    const values = layout.rows.map((x) => ({ row_from: x.r, row_to: x.r, col_from: x.c, col_to: x.c, op_type: 'cell_operation_type_formula', formula: x.v }))
    const merges = layout.merges.map((m) => ({ row_from: m.r1, row_to: m.r2, col_from: m.c1, col_to: m.c2, op_type: 'cell_operation_type_merge', merge_type: 'merge_type_center' }))
    const formats = layout.formats.map((f) => ({ row_from: f.r1, row_to: f.r2, col_from: f.c1, col_to: f.c2, op_type: 'cell_operation_type_format', xf: f.xf }))
    for (const batch of [values, merges, formats]) {
      const res = await runCli(cli, ['api', 'post', `/v7/sheets/${fileId}/worksheets/${sid}/range_data/batch_update`, '--data', JSON.stringify({ range_data: batch }), '-o', 'json'])
      if (!res.ok) throw new Error(`写入报价单失败：${res.stderr || res.stdout}`)
    }
    const fm = await runCli(cli, ['api', 'get', `/v7/files/${fileId}/meta`, '-o', 'json'])
    return { fileId, name, link: fm.json?.data?.link_url || '', sheetId: sid }
  }

  // ── 自定义模板：扫描 + 按模板渲染 ──────────────────────────
  async function scanTemplates() {
    const folderNode = config.templateFolderNode || 'cuHskXQMMJkZ'
    const items = await wikiChildren(folderNode)
    const existing = await list('quoteTemplates')
    const known = new Set(existing.map((x) => x['文件ID']))
    const cli = await cliOk()
    let added = 0
    for (const it of items) {
      if (it.type !== 'file' || !/\.xlsx$/i.test(it.name)) continue
      const meta = await runCli(cli, ['api', 'get', `/v7/files/${it.id}/meta`, '-o', 'json'])
      const real = meta.json?.data?.id
      const link = meta.json?.data?.link_url || ''
      if (!real || known.has(real)) continue
      await create('quoteTemplates', [{
        '模板名称': it.name.replace(/\.xlsx$/i, ''),
        '模板类型': '自定义',
        '版本': 'V1',
        '适用场景': '用户上传的自定义模板',
        '文件链接': link,
        '文件ID': real,
        '启用状态': '启用',
        '默认模板': false,
        '占位符规范': '支持 {{项目名称}} {{客户名称}} {{报价单号}} {{报价日期}} {{报价人}} {{报价版本}} {{含税合计}} {{未税合计}} {{税额合计}}；明细行放 {{序号}} {{产品类型}} {{产品名称}} {{规格}} {{品牌}} {{型号}} {{单价}} {{单位}} {{数量}} {{总价}} {{税率}} {{备注}}（可复制多行占位行）。',
        '备注': '由扫描 报价模板/ 目录自动登记',
      }])
      added += 1
    }
    return { added, total: items.filter((x) => /\.xlsx$/i.test(x.name)).length }
  }

  async function templateHasTokens(fileId) {
    try {
      const cli = await cliOk()
      const sheets = await runCli(cli, ['api', 'get', `/v7/sheets/${fileId}/worksheets`, '-o', 'json'])
      const sid = sheets.json?.data?.sheets?.[0]?.sheet_id
      if (!sid) return false
      const rng = await runCli(cli, ['api', 'get', `/v7/sheets/${fileId}/worksheets/${sid}/range_data`, '--query', 'row_from=0', '--query', 'row_to=80', '--query', 'col_from=0', '--query', 'col_to=20', '-o', 'json'])
      return (rng.json?.data?.range_data || []).some((c) => String(c.cell_text || '').includes('{{'))
    } catch { return false }
  }

  async function copyTemplateAndFill(tpl, dto, meta) {
    const folderNode = await ensureRenderFolder()
    const cli = await cliOk()
    const folderMeta = await runCli(cli, ['api', 'get', `/v7/files/${folderNode}/meta`, '-o', 'json'])
    const folderReal = folderMeta.json?.data?.id
    const before = new Set((await wikiChildren(folderNode)).map((x) => x.id))
    const copied = await runCli(cli, ['drive', 'file', 'batch-copy', SPACE, '--file-ids', tpl['文件ID'], '--dst-drive-id', SPACE, '--dst-parent-id', folderReal, '-o', 'json'])
    if (!copied.ok) throw new Error(`复制模板失败：${copied.stderr || copied.stdout}`)
    let node = null
    for (let i = 0; i < 30 && !node; i += 1) {
      await new Promise((r) => setTimeout(r, 800))
      node = (await wikiChildren(folderNode)).find((x) => !before.has(x.id) && x.type === 'file') || null
    }
    if (!node) throw new Error('复制模板超时')
    const metaRes = await runCli(cli, ['api', 'get', `/v7/files/${node.id}/meta`, '-o', 'json'])
    const realId = metaRes.json?.data?.id
    const safeCustomer = String(dto.customerName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)
    const name = `${meta.quoteNo || 'DRAFT'}_${safeCustomer}_${tpl['模板名称'] || '报价单'}.xlsx`
    await runCli(cli, ['drive', 'file', 'rename', SPACE, realId, '--name', name, '-o', 'json'])
    const sheets = await runCli(cli, ['api', 'get', `/v7/sheets/${realId}/worksheets`, '-o', 'json'])
    const sid = sheets.json?.data?.sheets?.[0]?.sheet_id
    const rng = await runCli(cli, ['api', 'get', `/v7/sheets/${realId}/worksheets/${sid}/range_data`, '--query', 'row_from=0', '--query', 'row_to=80', '--query', 'col_from=0', '--query', 'col_to=20', '-o', 'json'])
    const cells = rng.json?.data?.range_data || []
    const scalar = {
      '{{项目名称}}': dto.customerName || meta.customerName || '',
      '{{客户名称}}': dto.customerName || meta.customerName || '',
      '{{报价单号}}': meta.quoteNo || '',
      '{{报价日期}}': meta.date || today(),
      '{{报价人}}': meta.sales || '',
      '{{报价版本}}': meta.version || 'V1',
      '{{含税合计}}': dto.totals?.grossTotal ?? '',
      '{{未税合计}}': dto.totals?.untaxedTotal ?? '',
      '{{税额合计}}': dto.totals?.taxTotal ?? '',
      '{{方案概述}}': meta.notes || '',
      '{{服务内容}}': meta.service || '',
      '{{售后保障}}': meta.warranty || '',
      '{{报价说明}}': meta.notes || '',
    }
    const sections = await templateSections(tpl['模板名称'] || '')
    const plan = planSectionWrites(dto.lines || [], sections, cells, { scalars: scalar })
    if (plan.overflow.length) {
      throw new Error(`模板分节明细行不足：${plan.overflow.map((x) => `${x.section || '未分节'}「${x.name}」`).join('、')}，请在该分节补占位行`)
    }
    const updates = plan.writes.map((w) => ({
      row_from: w.row, row_to: w.row, col_from: w.col, col_to: w.col,
      op_type: 'cell_operation_type_formula', formula: w.text,
    }))
    const taken = new Set(plan.writes.map((w) => `${w.row}:${w.col}`))
    const emptyRows = new Set(plan.emptySlots.map((x) => x.row))
    for (const c of cells) {
      const key = `${c.row_from}:${c.col_from}`
      if (taken.has(key)) continue
      const t = String(c.cell_text || '')
      if (!t.includes('{{')) continue
      if (emptyRows.has(c.row_from)) {
        updates.push({ row_from: c.row_from, row_to: c.row_from, col_from: c.col_from, col_to: c.col_from, op_type: 'cell_operation_type_formula', formula: '' })
        continue
      }
      const value = t.replace(/\{\{[^{}]+\}\}/g, (m) => (scalar[m] === undefined ? '' : String(scalar[m])))
      updates.push({ row_from: c.row_from, row_to: c.row_from, col_from: c.col_from, col_to: c.col_from, op_type: 'cell_operation_type_formula', formula: value })
    }
    const ok = await runCli(cli, ['api', 'post', `/v7/sheets/${realId}/worksheets/${sid}/range_data/batch_update`, '--data', JSON.stringify({ range_data: updates }), '-o', 'json'])
    if (!ok.ok) throw new Error(`写入模板失败：${ok.stderr || ok.stdout}`)
    const fm = await runCli(cli, ['api', 'get', `/v7/files/${realId}/meta`, '-o', 'json'])
    return { fileId: realId, name, link: fm.json?.data?.link_url || '' }
  }

  async function renderByTemplate(dto, meta, tplName) {
    try {
      const tpl = (await list('quoteTemplates')).find((t) => t['模板名称'] === tplName)
      if (tpl && tpl['文件ID'] && tpl['启用状态'] !== '停用') {
        // 模板里有 {{...}} 占位符才按模板复制填充；纯版式模板继续走内置渲染
        if (await templateHasTokens(tpl['文件ID'])) {
          const filled = await copyTemplateAndFill(tpl, dto, meta)
          if (filled) return filled
        }
      }
    } catch { /* 回退内置布局 */ }
    return renderQuoteXlsx(dto, meta)
  }

  // ── 本地一次性模板（不入库） ────────────────────────────────
  function localTemplateDir() {
    const base = process.env.DSH_PROFILE_DIR || path.join(homedir(), '.dsh')
    return path.join(base, 'presales-local-templates')
  }

  async function saveLocalTemplate({ name, data }) {
    if (!data) throw new Error('缺少模板内容')
    const dir = localTemplateDir()
    await mkdir(dir, { recursive: true })
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(path.join(dir, `${id}.xlsx`), Buffer.from(String(data), 'base64'))
    return { id, name: String(name || '本地模板.xlsx') }
  }

  function tokenMap(dto, meta) {
    return {
      '{{项目名称}}': dto.customerName || meta.customerName || '',
      '{{客户名称}}': dto.customerName || meta.customerName || '',
      '{{报价单号}}': meta.quoteNo || '',
      '{{报价日期}}': meta.date || today(),
      '{{报价人}}': meta.sales || '',
      '{{报价版本}}': meta.version || 'V1',
      '{{含税合计}}': dto.totals?.grossTotal ?? '',
      '{{未税合计}}': dto.totals?.untaxedTotal ?? '',
      '{{税额合计}}': dto.totals?.taxTotal ?? '',
      '{{方案概述}}': meta.notes || '',
      '{{服务内容}}': meta.service || '',
      '{{售后保障}}': meta.warranty || '',
      '{{报价说明}}': meta.notes || '',
    }
  }

  function fillLocalSheet(ws, dto, meta) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:K40')
    const slots = []
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        const t = cell && typeof cell.v === 'string' ? cell.v : ''
        if (t.includes('{{序号}}') || t.includes('{{产品名称}}')) { slots.push(r); break }
      }
    }
    const slotIndex = new Map(slots.map((r, i) => [r, i]))
    const scalar = tokenMap(dto, meta)
    const items = dto.lines || []
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = XLSX.utils.encode_cell({ r, c })
        const cell = ws[addr]
        if (!cell || typeof cell.v !== 'string' || !cell.v.includes('{{')) continue
        let value = cell.v
        if (slotIndex.has(r)) {
          const item = items[slotIndex.get(r)]
          const detail = {
            '{{序号}}': item?.lineNo ?? '', '{{产品类型}}': item?.category || '', '{{产品名称}}': item?.name || '',
            '{{规格}}': item?.spec || '', '{{品牌}}': item?.brand || '', '{{型号}}': item?.model || '',
            '{{单价}}': item?.grossUnit ?? '', '{{单位}}': item?.unit || '', '{{数量}}': item?.qty ?? '',
            '{{总价}}': item?.grossSubtotal ?? '', '{{税率}}': item ? `${(Number(item.taxRate) * 100).toFixed(0)}%` : '',
            '{{备注}}': item?.remark || '',
          }
          value = value.replace(/\{\{[^{}]+\}\}/g, (m) => (detail[m] === undefined ? '' : String(detail[m])))
        } else {
          value = value.replace(/\{\{[^{}]+\}\}/g, (m) => (scalar[m] === undefined ? '' : String(scalar[m])))
        }
        cell.v = value
        cell.t = 's'
      }
    }
  }

  async function renderLocalTemplate(dto, meta, localId) {
    const wb = XLSX.readFile(path.join(localTemplateDir(), `${localId}.xlsx`))
    for (const name of wb.SheetNames) fillLocalSheet(wb.Sheets[name], dto, meta)
    const outDir = path.resolve(config.outputDir || path.join(homedir(), '.dsh', 'presales-out', 'quotes'))
    await mkdir(outDir, { recursive: true })
    const fileName = `${meta.quoteNo || 'DRAFT'}_${String(dto.customerName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}_报价单.xlsx`
    const outFile = path.join(outDir, fileName)
    XLSX.writeFile(wb, outFile)
    return { filePath: outFile, fileName, link: `/presales/api/download?f=${encodeURIComponent(fileName)}` }
  }

  // ── 模板文件变更检测 ────────────────────────────────────────
  async function callHostTool(name, args) {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
    if (!tools || typeof tools.execute !== 'function') throw new Error('工具服务不可用')
    const def = tools.get(name)
    if (!def) throw new Error(`未安装或未启用 ${name}`)
    const ctrl = new AbortController()
    const res = await tools.execute({
      name, arguments: args, callId: `presales-${name}-${Date.now()}`,
      signal: ctrl.signal,
    })
    if (res.isError) throw new Error(res.error?.message || `${name} 执行失败`)
    return res.value
  }

  async function emailAccounts() {
    const health = await callHostTool('email_health', {})
    const accounts = []
    const list = health?.accounts || health?.checks || []
    for (const a of list) {
      const name = String(a.name || a.account || a.label || '').replace(/^账号\s*/, '').trim()
      if (!name || name === '邮箱配置') continue
      const email = (String(a.detail || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0]
      const label = email ? `${name} · ${email}` : name
      accounts.push({ name, email, label })
    }
    const uniq = []
    for (const a of accounts) if (!uniq.some((x) => x.name === a.name)) uniq.push(a)
    return { accounts: uniq, defaultAccount: uniq[0]?.name || '', raw: health }
  }

  async function nextRfqNo() {
    // 同时看头和明细：避免删了头但明细残留时复用同一个编号，导致新旧明细串单
    const [headers, items] = await Promise.all([list('rfq'), list('rfqItems')])
    const year = new Date().getFullYear()
    let max = 0
    for (const r of [...headers, ...items]) {
      const m = String(r['询价编号'] || '').match(/RFQ-(\d{4})-(\d+)/)
      if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]))
    }
    return `RFQ-${year}-${String(max + 1).padStart(4, '0')}`
  }

  async function createRfqBatch(payload = {}) {
    const items = Array.isArray(payload.items) && payload.items.length ? payload.items : [payload]
    const no = await nextRfqNo()
    const header = {
      '询价编号': no,
      '商机编号': payload.opportunityNo || '',
      '商机名称': payload.opportunityName || '',
      '报价单号': payload.quoteNo || '',
      '厂商名称': payload.vendor || '',
      '厂商邮箱': payload.vendorEmail || '',
      '询价状态': '草稿',
      '收件人确认': '待确认',
      '备注': payload.note || '',
    }
    const clean = {}
    for (const [k, v] of Object.entries(header)) { if (v !== null && v !== undefined && v !== '') clean[k] = v }
    const [id] = await create('rfq', [clean])
    const rows = items.map((it) => {
      const row = {
        '询价编号': no,
        '产品名称': it.name || '',
        '规格': it.spec || '',
        '品牌': it.brand || '',
        '型号': it.model || '',
        '单位': it.unit || '项',
        '数量': Number(it.qty) || 1,
        '目标价（含税）': Number(it.targetPrice) || null,
        '关联报价行标识': it.lineId || it.code || '',
        '备注': it.note || '',
      }
      const c = {}
      for (const [k, v] of Object.entries(row)) { if (v !== null && v !== undefined && v !== '') c[k] = v }
      return c
    })
    if (rows.length) await create('rfqItems', rows)
    const result = { id, no, itemCount: rows.length, vendor: payload.vendor || '' }
    if (payload.withMail) {
      try {
        const mail = buildRfqMail({
          rfq: { ...header, items: items.map((it) => ({ name: it.name, spec: it.spec, brand: it.brand, model: it.model, unit: it.unit, qty: it.qty, targetPrice: it.targetPrice, note: it.note })) },
          opportunity: { no: payload.opportunityNo, name: payload.opportunityName },
          sender: { name: '' },
          recipients: payload.vendorEmail || '',
        })
        result.mail = { ...mail, id, to: payload.vendorEmail || '', rfqNo: no, itemCount: rows.length }
      } catch (e) { result.mailError = String(e.message || e) }
    }
    return result
  }

  async function listRfqs() {
    const [headers, items] = await Promise.all([list('rfq'), list('rfqItems')])
    return headers.slice().reverse().map((h) => {
      const lines = items.filter((x) => x['询价编号'] === h['询价编号'])
      return {
        id: h._id, no: h['询价编号'], opportunityNo: h['商机编号'] || '', opportunityName: h['商机名称'] || '',
        vendor: h['厂商名称'] || '', vendorEmail: h['厂商邮箱'] || '', status: h['询价状态'] || '',
        itemCount: lines.length, section: lines[0] ? '' : '',
        sentAt: h['发送时间'] || '', createdAt: h['创建时间'] || '',
      }
    })
  }

  async function rfqDetail(id) {
    const headers = await list('rfq')
    const h = headers.find((x) => x._id === id || x['询价编号'] === id)
    if (!h) throw new Error('询价单不存在')
    const items = (await list('rfqItems')).filter((x) => x['询价编号'] === h['询价编号'])
    return { header: { id: h._id, ...h }, items: items.map((x) => ({ id: x._id, ...x })) }
  }

  async function rfqMailPreview(id) {
    const detail = await rfqDetail(id)
    const h = detail.header
    const rfq = { ...h, items: detail.items.map((x) => ({
      name: x['产品名称'], spec: x['规格'], brand: x['品牌'], model: x['型号'],
      unit: x['单位'], qty: x['数量'], targetPrice: x['目标价（含税）'], note: x['备注'],
    })) }
    const mail = buildRfqMail({
      rfq,
      opportunity: { no: h['商机编号'], name: h['商机名称'] },
      sender: { name: '' },
      recipients: h['厂商邮箱'] || '',
    })
    return { ...mail, id: h._id, to: h['厂商邮箱'] || '', rfqNo: h['询价编号'], itemCount: detail.items.length }
  }

  function extractPrice(text) {
    const t = String(text || '')
    const patterns = [
      /(?:含税|总价|报价|价格|单价)[^\d]{0,15}([0-9][0-9,]*(?:\.[0-9]+)?)/i,
      /(?:￥|¥|RMB|CNY)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,
    ]
    for (const re of patterns) {
      const m = t.match(re)
      if (m) return Number(m[1].replace(/,/g, ''))
    }
    const nums = [...t.matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)/g)]
      .map((x) => Number(x[1].replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n >= 10 && n < 1e9)
    return nums.length ? Math.max(...nums) : null
  }

  async function recalcVersionTotals(versionId) {
    const items = (await list('quoteItems')).filter((it) => (it['报价版本'] || []).includes(versionId))
    const ver = (await list('quoteVersions')).find((v) => v._id === versionId)
    if (!ver) return
    const sum = (k) => round(items.reduce((a, it) => a + (Number(it[k]) || 0), 0), 2)
    const untaxed = sum('不含税小计'); const tax = sum('税额'); const gross = sum('含税小计')
    await updateRecord('quoteVersions', versionId, { '不含税合计': untaxed, '税额合计': tax, '含税合计': gross })
    for (const qid of (ver['报价单'] || [])) await updateRecord('quotes', qid, { '不含税合计': untaxed, '税额合计': tax, '含税合计': gross })
  }

  async function updateRfqHeader(id, payload = {}) {
    const h = (await list('rfq')).find((x) => x._id === id || x['询价编号'] === id)
    if (!h) throw new Error('询价单不存在')
    const patch = {}
    if (payload.vendorEmail !== undefined) patch['厂商邮箱'] = payload.vendorEmail
    if (payload.vendor !== undefined) patch['厂商名称'] = payload.vendor
    if (Object.keys(patch).length) await updateRecord('rfq', h._id, patch)
    return { ok: true }
  }

  async function applyRfqItemPrice(itemId, price) {
    const item = (await list('rfqItems')).find((x) => x._id === itemId)
    if (!item) throw new Error('询价明细不存在')
    const unitPrice = Number(price) || 0
    await updateRecord('rfqItems', item._id, { '回复报价（含税）': unitPrice })
    const no = item['询价编号']
    await updateRecord('rfq', (await list('rfq')).find((h) => h['询价编号'] === no)._id, { '询价状态': '已回复' })
    const quoteItems = (await list('quoteItems')).filter((it) => it['询价编号'] === no && (it['产品名称'] === item['产品名称'] || String(it['备注'] || '').includes(item['关联报价行标识'] || '')))
    let applied = 0
    for (const it of quoteItems) {
      const qty = Number(it['数量']) || 1
      const rate = Number(it['税率']) || 0.13
      const untaxed = round(unitPrice / (1 + rate), 4)
      const untaxedSub = round(untaxed * qty, 2)
      await updateRecord('quoteItems', it._id, {
        '含税单价': unitPrice, '不含税单价': untaxed, '税额': round(untaxedSub * rate, 2),
        '不含税小计': untaxedSub, '含税小计': round(unitPrice * qty, 2), '价格状态': '已核价',
        '备注': [it['备注'], `询价明细回填 ${unitPrice}`].filter(Boolean).join('；'),
      })
      for (const vid of (it['报价版本'] || [])) await recalcVersionTotals(vid)
      applied += 1
    }
    return { ok: true, applied }
  }

  async function syncRfqReplies(days = 30) {
    const [headers, allItems] = await Promise.all([list('rfq'), list('rfqItems')])
    const pending = headers.filter((h) => h['询价状态'] !== '已核价')
    const results = []
    for (const h of pending) {
      const no = h['询价编号']
      let mails = []
      try {
        const searched = await callHostTool('email_search', { query: no, limit: 5, since: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) })
        mails = searched?.items || searched?.messages || []
      } catch (e) { results.push({ no, error: `邮件搜索失败：${e.message}` }); continue }
      for (const m of mails) {
        if (!m?.uid) continue
        let body = ''
        try {
          const read = await callHostTool('email_read', { uid: m.uid, folder: m.folder || '' })
          body = read?.text || read?.body || ''
        } catch { body = '' }
        const hay = `${m.subject || ''}\n${body}`
        const price = extractPrice(hay)
        if (!price || !hay.includes(no)) continue
        const lines = allItems.filter((x) => x['询价编号'] === no)
        await updateRecord('rfq', h._id, {
          '询价状态': '已回复', '回复报价（含税）': price, '回复日期': (m.date || today()).slice(0, 10),
          '备注': [h['备注'], `邮件回复：${String(m.subject || '').slice(0, 80)}`].filter(Boolean).join('\n'),
        })
        let applied = 0
        if (lines.length === 1) {
          const item = lines[0]
          await updateRecord('rfqItems', item._id, { '回复报价（含税）': price })
          const quoteItems = (await list('quoteItems')).filter((it) => it['询价编号'] === no && it['价格状态'] !== '已核价')
          for (const it of quoteItems) {
            const qty = Number(it['数量']) || 1
            const untaxed = round(price / (1 + (Number(it['税率']) || 0.13)), 4)
            const untaxedSub = round(untaxed * qty, 2)
            await updateRecord('quoteItems', it._id, {
              '含税单价': price, '不含税单价': untaxed, '税额': round(untaxedSub * (Number(it['税率']) || 0.13), 2),
              '不含税小计': untaxedSub, '含税小计': round(price * qty, 2), '价格状态': '已核价',
              '备注': [it['备注'], `询价回复回填 ${price}`].filter(Boolean).join('；'),
            })
            for (const vid of (it['报价版本'] || [])) await recalcVersionTotals(vid)
            applied += 1
          }
        }
        results.push({ no, price, applied, needsReview: lines.length > 1 })
        break
      }
    }
    return { checked: pending.length, updated: results.filter((r) => r.price) }
  }

  async function markRfqSent(id, payload = {}) {
    const rec = (await list('rfq')).find((x) => x._id === id || x['询价编号'] === id)
    if (!rec) throw new Error('询价单不存在')
    await updateRecord('rfq', rec._id, {
      '询价状态': '已发送',
      '收件人确认': '已确认',
      '发件账号': payload.sender || '',
      '邮件消息ID': payload.messageId || '',
      '发送时间': payload.sentAt || today(),
    })
    return { ok: true }
  }

  async function replyRfq(id, payload = {}) {
    const rec = (await list('rfq')).find((x) => x._id === id || x['询价编号'] === id)
    if (!rec) throw new Error('询价单不存在')
    await updateRecord('rfq', rec._id, {
      '询价状态': '已回复',
      '回复报价（含税）': Number(payload.price) || null,
      '回复日期': payload.date || today(),
      '备注': [rec['备注'], payload.note].filter(Boolean).join('\n'),
    })
    return { ok: true }
  }

  async function templateSections(templateName) {
    try {
      const rec = (await list('quoteTemplates')).find((t) => t['模板名称'] === templateName)
      const fileId = rec && rec['文件ID']
      if (!fileId) return [{ title: '产品报价', row: null }]
      const cli = await cliOk()
      const sheets = await runCli(cli, ['api', 'get', `/v7/sheets/${fileId}/worksheets`, '-o', 'json'])
      const sid = sheets.json?.data?.sheets?.[0]?.sheet_id
      if (!sid) return [{ title: '产品报价', row: null }]
      const rng = await runCli(cli, ['api', 'get', `/v7/sheets/${fileId}/worksheets/${sid}/range_data`, '--query', 'row_from=0', '--query', 'row_to=80', '--query', 'col_from=0', '--query', 'col_to=5', '-o', 'json'])
      const cells = rng.json?.data?.range_data || []
      const out = []
      const seen = new Set()
      for (const c of cells) {
        const t = String(c.cell_text || '').trim()
        if (!t || t.length > 30) continue
        const isNum = /^[一二三四五六七八九十]+、/.test(t)
        const isKeyword = /^(软件产品|硬件产品|实施及服务|实施服务|安装实施|运维服务|服务类?|产品报价)$/.test(t)
        if ((isNum || isKeyword) && !seen.has(t)) { seen.add(t); out.push({ title: t, row: c.row_from }) }
      }
      return out.length ? out : [{ title: '产品报价', row: null }]
    } catch { return [{ title: '产品报价', row: null }] }
  }

  async function templateFiles() {
    const node = config.templateFolderNode || 'cuHskXQMMJkZ'
    const items = await wikiChildren(node)
    const cli = await cliOk()
    const out = []
    for (const it of items) {
      if (it.type !== 'file' || !/\.xlsx$/i.test(it.name)) continue
      const meta = await runCli(cli, ['api', 'get', `/v7/files/${it.id}/meta`, '-o', 'json'])
      const real = meta.json?.data?.id
      if (real) out.push({ name: it.name.replace(/\.xlsx$/i, ''), fileId: real, link: meta.json?.data?.link_url || '' })
    }
    return out
  }

  async function checkTemplateFiles() {
    const files = await templateFiles()
    const recs = await list('quoteTemplates')
    const known = new Map(recs.filter((r) => r['文件ID']).map((r) => [r['文件ID'], r]))
    const fileIds = new Set(files.map((f) => f.fileId))
    const added = []
    const updates = []
    for (const f of files) {
      if (known.has(f.fileId)) continue
      const byName = recs.find((r) => r['模板名称'] === f.name)
      if (byName) updates.push({ id: byName._id, name: f.name, fileId: f.fileId, link: f.link })
      else added.push(f)
    }
    const missing = recs.filter((r) => r['文件ID'] && !fileIds.has(r['文件ID'])).map((r) => ({ id: r._id, name: r['模板名称'], fileId: r['文件ID'] }))
    return { added, updates, missing, total: files.length }
  }

  async function syncTemplateFiles() {
    const diff = await checkTemplateFiles()
    let updated = 0; let created = 0; let disabled = 0
    for (const u of diff.updates) {
      await updateRecord('quoteTemplates', u.id, { '文件ID': u.fileId, '文件链接': u.link })
      updated += 1
    }
    for (const a of diff.added) {
      await create('quoteTemplates', [{
        '模板名称': a.name, '模板类型': '自定义', '版本': 'V1', '启用状态': '启用', '默认模板': false,
        '文件ID': a.fileId, '文件链接': a.link,
        '占位符规范': '支持 {{项目名称}} {{客户名称}} {{报价单号}} {{报价日期}} {{报价人}} {{报价单号}} {{含税合计}}；明细行 {{序号}} {{产品类型}} {{产品名称}} {{品牌}} {{型号}} {{单价}} {{单位}} {{数量}} {{总价}} {{税率}} {{备注}}',
      }])
      created += 1
    }
    for (const m of diff.missing) {
      await updateRecord('quoteTemplates', m.id, { '启用状态': '停用' })
      disabled += 1
    }
    return { updated, created, disabled, ...(await checkTemplateFiles()) }
  }

  async function loadQuoteDto(quoteNo) {
    const [quotes, versions, items] = await Promise.all([list('quotes'), list('quoteVersions'), list('quoteItems')])
    const q = quotes.find((x) => x['报价单号'] === quoteNo)
    if (!q) throw new Error(`未找到报价单 ${quoteNo}`)
    const vs = versions.filter((v) => (v['报价单'] || []).includes(q._id)).sort((a, b) => Number(a['版本号']) - Number(b['版本号'])).pop()
    const its = items.filter((i) => (i['报价版本'] || []).includes(vs?._id))
    const catalog = await loadCatalog().catch(() => [])
    const byCode = new Map(catalog.map((p) => [p.code, p]))
    const lines = its.sort((a, b) => Number(a['序号']) - Number(b['序号'])).map((i) => ({
      lineNo: Number(i['序号']) || 0, code: i['产品编码'], name: i['产品名称'], spec: i['规格'] || '',
      brand: i['品牌'] || '', model: i['型号'] || '', unit: i['单位'] || '', qty: Number(i['数量']) || 0,
      discount: Number(i['折扣']) || 1, stdPrice: Number(i['标准未税单价']) || 0,
      untaxedUnit: Number(i['不含税单价']) || 0, untaxedSubtotal: Number(i['不含税小计']) || 0,
      taxRate: Number(i['税率']) || 0, tax: Number(i['税额']) || 0,
      grossUnit: Number(i['含税单价']) || 0, grossSubtotal: Number(i['含税小计']) || 0,
      costSubtotal: 0, section: i['分节'] || '一、产品报价', remark: i['备注'] || '',
      category: byCode.get(i['产品编码'])?.l2 || '',
      lineType: i['行类型'] || '目录产品', rfqNo: i['询价编号'] || '', priceStatus: i['价格状态'] || '已定价',
    }))
    return {
      customerName: q['客户名称'] || '', customerNo: q['客户编号'] || '', opportunityNo: q['商机编号'] || '',
      template: q['模板'] || '',
      lines,
      totals: {
        untaxedTotal: Number(q['不含税合计']) || 0, taxTotal: Number(q['税额合计']) || 0,
        grossTotal: Number(q['含税合计']) || 0, costTotal: 0, profit: 0, margin: Number(q['毛利率']) || null,
      },
      meta: { quoteNo, customerName: q['客户名称'] || '', date: today(), sales: '', validUntil: vs?.['有效期至'] || '' },
    }
  }

  // ── 技能：把商机/报价规则注册进会话目录 ────────────────────
  function registerPresalesSkill() {
    let skills = null
    try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : ctx.skills } catch { skills = null }
    if (!skills || typeof skills.register !== 'function') return
    const skill = {
      name: 'digital-presales',
      description: '数字售前：商机新建/推进/跟进，报价计价/模块拆行/V2/Excel 出单，以及 WPS 数据联动规则。',
      whenToUse: '用户提到商机、推进阶段、跟进、报价、报价单、V2、出单，或要求在数字售前面板里操作时。',
      content: PRESALES_SKILL,
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'opaque', description: '内置在 @cnbm/dsh-presales 插件中' },
    }
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => skills.register(skill))
      else skills.register(skill)
    } catch { /* 技能注册失败不影响工具 */ }
  }
  registerPresalesSkill()

  // ── Web 面板接口（同源，带自定义头） ──────────────────────
  async function buildQuoteLinesFromItems(inputItems) {
const catalog = await loadCatalog()
const lines = []
const violations = []
for (const [idx, it] of (body.items || []).entries()) {
  let p
  if (it.temp) {
    p = {
      id: `temp-${idx}`, code: it.code || `TMP-${Date.now()}-${idx}`, name: it.name || '临时产品',
      spec: it.spec || '', brand: it.brand || '', model: it.model || '', unit: it.unit || '项',
      stdPrice: Number(it.price) || 0, costPrice: 0, taxRate: 0.13, minDiscount: 0, modules: [], l2: '', status: '在售',
    }
  } else {
    const found = findProduct(catalog, it.code || it.name)
    if (found.error) { violations.push({ level: 'block', message: `${it.code || it.name}：${found.error}` }); continue }
    if (found.candidates) { violations.push({ level: 'block', message: `「${it.code || it.name}」匹配到多个产品` }); continue }
    p = found.product
    if (it.name !== undefined) p = { ...p, name: it.name }
    if (it.brand !== undefined) p = { ...p, brand: it.brand }
    if (it.model !== undefined) p = { ...p, model: it.model }
    if (it.spec !== undefined) p = { ...p, spec: it.spec }
    if (it.unit !== undefined) p = { ...p, unit: it.unit }
    if (it.category !== undefined) p = { ...p, l2: it.category }
    if (it.taxRate !== undefined) p = { ...p, taxRate: Number(it.taxRate) || p.taxRate }
    if (it.stdPrice !== undefined) p = { ...p, stdPrice: Number(it.stdPrice) }
  }
  const qty = Number(it.qty) || 0
  const discount = Number(it.discount) || 1
  const expanded = expandProduct(p, { qty, discount, modules: it.modules, section: it.section || '' })
  for (const e of expanded) {
    if (!it.temp) {
      for (const v of validateLine({ product: { ...p, name: e.name, stdPrice: e.stdPrice, costPrice: e.costPrice }, qty, discount, today: today() })) {
        if (v.level === 'block') violations.push({ product: p.code, ...v })
      }
    }
    const money = computeLine({ stdPrice: e.stdPrice, costPrice: e.costPrice, discount, qty, taxRate: e.taxRate })
    lines.push({
      lineNo: lines.length + 1, code: e.code, name: e.name, spec: e.spec, brand: e.brand, model: e.model, unit: e.unit, qty, discount,
      stdPrice: e.stdPrice, ...money, section: e.section,
      lineType: it.temp ? '临时产品' : '目录产品',
      rfqNo: it.rfqNo || '',
      priceStatus: it.temp ? (Number(it.price) > 0 ? '暂估' : '待询价') : '已定价',
      remark: it.remark || (it.temp ? `临时产品（${it.rfqNo || '待询价'}）` : (e.remark || '')), category: e.category,
    })
  }
}
    return { lines, violations }
  }

  async function persistQuote(dto, opts = {}) {
    const quotes = await list('quotes')
    const year = new Date().getFullYear()
    const max = quotes.reduce((m, q) => {
      const mm = /^BJ-(\d{4})-(\d+)$/.exec(q['报价单号'] || '')
      return mm && Number(mm[1]) === year ? Math.max(m, Number(mm[2])) : m
    }, 0)
    const quoteNo = opts.quoteNo || `BJ-${year}-${String(max + 1).padStart(4, '0')}`
    const version = 'V1'
    const versionKey = `${quoteNo}-${version}`
    const validityDays = Number(opts.validityDays) || 30
    const validUntil = new Date(Date.now() + validityDays * 86400000).toISOString().slice(0, 10)
    const tplName = opts.template || dto.template || '简易报价模板'
    const key = crypto.createHash('sha1').update(JSON.stringify({ c: dto.customerName || '', items: dto.lines.map((l) => [l.code, l.qty, l.discount]) })).digest('hex').slice(0, 16)
    const exist = quotes.find((q) => q['幂等键'] === key && q['状态'] !== '作废')
    if (exist) return { quoteNo: exist['报价单号'], existed: true, grossTotal: exist['含税合计'] }
    const [quoteId] = await create('quotes', [{
      '报价单号': quoteNo, '商机编号': dto.opportunityNo || '', '商机名称': dto.opportunityName || '',
      '客户编号': dto.customerNo || '', '客户名称': dto.customerName || '', '模板': tplName,
      '当前版本': version, '状态': '草稿',
      '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal, '含税合计': dto.totals.grossTotal,
      '毛利率': dto.totals.margin ?? '', '价目表版本': 'v1', '幂等键': key,
    }])
    const [versionId] = await create('quoteVersions', [{
      '版本标识': versionKey, '报价单': [quoteId], '报价单号': quoteNo, '版本号': 1, '状态': '草稿',
      '模板': tplName, '提交时间': today(), '有效期至': validUntil,
      '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal, '含税合计': dto.totals.grossTotal,
      '成本合计': dto.totals.costTotal, '毛利额': dto.totals.profit, '毛利率': dto.totals.margin ?? '', '变更说明': '',
    }])
    const itemIds = await create('quoteItems', dto.lines.map((l) => ({
      '行标识': `${versionKey}-${String(l.lineNo).padStart(2, '0')}`, '报价版本': [versionId], '版本标识': versionKey,
      '序号': l.lineNo, '分节': l.section || '一、产品报价', '产品编码': l.code, '产品名称': l.name,
      '规格': l.spec, '品牌': l.brand, '型号': l.model, '单位': l.unit, '数量': l.qty,
      '标准未税单价': l.stdPrice, '折扣': l.discount, '不含税单价': l.untaxedUnit, '税率': l.taxRate,
      '税额': l.tax, '含税单价': l.grossUnit, '不含税小计': l.untaxedSubtotal, '含税小计': l.grossSubtotal, '备注': l.remark || '',
        '行类型': l.lineType || '目录产品', '询价编号': l.rfqNo || '', '价格状态': l.priceStatus || '已定价',
    })))
    return { quoteNo, quoteId, versionId, itemCount: itemIds.length, grossTotal: dto.totals.grossTotal }
  }

  // ── 插件更新（GitHub Releases） ─────────────────────────────
  const execFileAsync = promisify(execFile)
  const PKG_CNBM = '@cnbm/dsh-wps365'

  async function localPresalesVersion() {
    try { return JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return '' }
  }

  async function installedVersion(pkg) {
    const dir = process.env.DSH_PROFILE_DIR
    if (!dir) return ''
    try { return JSON.parse(await readFile(path.join(dir, 'node_modules', pkg, 'package.json'), 'utf8')).version } catch { return '' }
  }

  const GH_MIRRORS = ['', 'https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/']

  async function fetchWithTimeout(url, options = {}, timeout = 20000) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try { return await fetch(url, { ...options, signal: ctrl.signal }) } finally { clearTimeout(timer) }
  }

  async function ghLatest(repo) {
    try {
      const headers = { 'user-agent': 'dsh-presales-updater', accept: 'application/vnd.github+json' }
      if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`
      const r = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
      if (!r.ok) throw new Error(`GitHub ${r.status}`)
      const d = await r.json()
      const asset = (d.assets || []).find((a) => String(a.name).endsWith('.tgz'))
      return { tag: d.tag_name, published: d.published_at, asset: asset ? { name: asset.name, url: asset.browser_download_url } : null }
    } catch (error) {
      const pkgName = repo.endsWith('presales') ? 'cnbm-dsh-presales' : 'cnbm-dsh-wps365'
      const r = await fetchWithTimeout(`https://cdn.jsdelivr.net/gh/${repo}@latest/package.json`, {})
      if (!r.ok) throw new Error(`GitHub 与 jsDelivr 均不可达：${error.message || error}`)
      const pkg = await r.json()
      const tag = `v${pkg.version}`
      return { tag, published: '', asset: { name: `${pkgName}-${pkg.version}.tgz`, url: `https://github.com/${repo}/releases/download/${tag}/${pkgName}-${pkg.version}.tgz` } }
    }
  }

  async function downloadAsset(url) {
    let lastError = null
    for (const prefix of GH_MIRRORS) {
      try {
        const res = await fetchWithTimeout(prefix + url, { headers: { 'user-agent': 'dsh-presales-updater' } }, 60000)
        if (res.ok) return Buffer.from(await res.arrayBuffer())
        lastError = new Error(`HTTP ${res.status}`)
      } catch (e) { lastError = e }
    }
    throw new Error(`下载更新失败（GitHub 及镜像均不可达）：${lastError && lastError.message ? lastError.message : lastError}`)
  }

  async function checkUpdates() {
    const out = []
    for (const [key, repo] of Object.entries(config.updateRepos || {})) {
      if (!repo || key !== 'presales') continue
      try {
        const latest = await ghLatest(repo)
        const local = key === 'cnbm' ? await installedVersion(PKG_CNBM) : await localPresalesVersion()
        out.push({ key, repo, latest: latest.tag, local, asset: latest.asset, hasUpdate: Boolean(local && latest.tag && String(latest.tag).replace(/^v/, '') !== String(local)) })
      } catch (e) {
        out.push({ key, repo, error: String(e.message || e) })
      }
    }
    return out
  }

  async function updatePlugin(key) {
    const repo = (config.updateRepos || {})[key]
    if (!repo) throw new Error(`未配置 ${key} 的仓库`)
    const latest = await ghLatest(repo)
    if (!latest.asset) throw new Error('该 Release 没有 tgz 资产')
    const file = path.join(tmpdir(), latest.asset.name)
    await writeFile(file, await downloadAsset(latest.asset.url))
    const profile = process.env.DSH_PROFILE || 'desktop'
    const candidates = []
    const add = (p, requireExists = true) => { if (p && (!requireExists || existsSync(p))) candidates.push(p) }
    add(process.env.DSH_CLI)
    add('dsh', false)
    try {
      const m = String(process.execPath || '').match(/^(.*\/Contents)\/MacOS\//)
      if (m) add(path.join(m[1], 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
    } catch {}
    add(path.join(homedir(), '.local', 'bin', 'dsh'))
    add('/usr/local/bin/dsh')
    add('/opt/homebrew/bin/dsh')
    for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
      try {
        for (const app of readdirSync(dir)) {
          if (!/Harness/i.test(app) || !app.endsWith('.app')) continue
          add(path.join(dir, app, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
        }
      } catch {}
    }
    add('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
    add('/Applications/DeepSeek Harness Dev.app/Contents/Resources/runtime/cli/bin/dsh')
    const tried = []
    let lastError = null
    for (const dsh of [...new Set(candidates)]) {
      tried.push(dsh)
      try {
        await execFileAsync(dsh, ['plugin', '--profile', profile, 'add', file], { timeout: 300000 })
        lastError = null
        break
      } catch (e) { lastError = e }
    }
    if (lastError) throw new Error(`找不到可用的 dsh 命令（已尝试 ${tried.join('、') || '无'}）。请设置 DSH_CLI 指向 dsh，或手动执行：dsh plugin add "${file}"`)
    return { installed: latest.asset.name, tag: latest.tag, restartRequired: true }
  }

  // webServer 可能晚于本插件激活，必须等它出现再注册路由（与 cnbm 同一写法）。
  function mountPanel(runtime) {
    const webServer = runtime.webServer || (typeof runtime.get === 'function' ? runtime.get('webServer') : undefined)
    if (!webServer || typeof webServer.register !== 'function') return
    const prefix = '/presales/api/'
    const HEADER = 'x-dsh-presales'
    const json = (res, status, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
      res.end(body)
    }
    const loopback = (req) => {
      const host = String(req.headers.host || '').replace(/:\d+$/, '')
      if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false
      const origin = req.headers.origin
      if (origin) { try { if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(origin).host.replace(/:\d+$/, ''))) return false } catch { return false } }
      return true
    }
    const readBody = (req) => new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy() })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/presales',
      handler: async (req, res) => {
        if (!loopback(req)) { res.writeHead(403).end('forbidden'); return }
        let url
        try { url = new URL(req.url, 'http://127.0.0.1') } catch { res.writeHead(400).end('bad request'); return }
        if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end('not found'); return }
        if (req.headers[HEADER] !== '1') { res.writeHead(403).end('forbidden'); return }
        const route = url.pathname.slice(prefix.length)
        try {
          if (route === 'opp_save' && req.method === 'POST') {
            try {
              const b = await readBody(req)
              if (!String(b.name || '').trim()) return json(res, 400, { ok: false, error: '商机名称必填' })
              const no = await nextOppNo()
              const stage = b.stage || '线索阶段'
              if (!OPP_STAGES.includes(stage)) return json(res, 400, { ok: false, error: `阶段必须是：${OPP_STAGES.join('、')}` })
              const [id] = await create('opportunities', [{
                '商机编号': no, '商机名称': String(b.name).trim(), '客户编号': b.customerNo || '', '客户名称': b.customerName || '',
                '商机金额万元': Number(b.amount) || 0, '阶段': stage, '预计落单时间': b.expected || '',
                '来源': b.source || '主动开发',
                '联系人': b.contact || '', '联系电话': b.phone || '', '简介': b.intro || '',
                '销售姓名': b.sellerName || '', '售前姓名': b.ownerName || '', '赢单率': 0.1,
              }])
              await logOppChange({ oppId: id, oppNo: no, field: '新建', oldValue: '', newValue: stage, reason: '新建商机', by: b.ownerName })
              return json(res, 200, { ok: true, id, no })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'opps') {
            const kw = String(url.searchParams.get('keyword') || '').toLowerCase()
            const stage = url.searchParams.get('stage') || ''
            let rows = await list('opportunities')
            if (stage) rows = rows.filter((r) => r['阶段'] === stage)
            if (kw) rows = rows.filter((r) => `${r['商机编号']} ${r['商机名称']} ${r['客户名称']}`.toLowerCase().includes(kw))
            rows.sort((a, b) => String(b['更新时间'] || '').localeCompare(String(a['更新时间'] || '')))
            return json(res, 200, { ok: true, items: rows.map((r) => ({
              id: r._id, no: r['商机编号'], name: r['商机名称'], customerName: r['客户名称'] || '', customerNo: r['客户编号'] || '',
              stage: r['阶段'] || '', amount: Number(r['商机金额万元']) || 0, expected: normDate(r['预计落单时间']),
              seller: r['销售姓名'] || '', owner: r['售前姓名'] || '', source: r['来源'] || '',
              contact: r['联系人'] || '', phone: r['联系电话'] || '', intro: r['简介'] || '',
              createdAt: normDate(r['创建时间']), updated: normDate(r['更新时间']), winRate: r['赢单率'] == null ? null : Number(r['赢单率']),
            })) })
          }
          if (route === 'opp') {
            const no = url.searchParams.get('no') || ''
            const [opps, followups, changes, quotes, versions, documents] = await Promise.all([
              list('opportunities'), list('oppFollowups'), list('oppChanges'), list('quotes'), list('quoteVersions'), list('documents'),
            ])
            const r = opps.find((x) => x['商机编号'] === no)
            if (!r) return json(res, 404, { ok: false, error: `未找到商机 ${no}` })
            const qs = quotes.filter((q) => q['商机编号'] === no).map((q) => ({
              quoteNo: q['报价单号'], status: q['状态'], version: q['当前版本'], grossTotal: Number(q['含税合计']) || 0,
              link: q['文件链接'] || '', updated: String(q['更新时间'] || '').slice(0, 10),
              versions: versions.filter((v) => (v['报价单'] || []).includes(q._id)).map((v) => {
                const shortVer = String(v['版本标识'] || '').replace(`${q['报价单号']}-`, '')
                const doc = documents.find((d) => d['类型'] === '报价单' && (String(d['产物编号'] || '').includes(`${q['报价单号']}-${shortVer}`) || (String(d['版本'] || '') === shortVer && String(d['标题'] || '').includes(q['报价单号']))))
                return { version: v['版本标识'], shortVersion: shortVer, status: v['状态'], grossTotal: Number(v['含税合计']) || 0, change: v['变更说明'] || '', link: doc ? (doc['溯源'] || '') : '' }
              }),
            }))
            const docs = documents.filter((d) => d['商机编号'] === no).map((d) => ({ no: d['产物编号'], title: d['标题'], type: d['类型'], version: d['版本'], link: d['溯源'] || '', fileName: d['文件名'] || '' }))
            return json(res, 200, { ok: true, item: {
              id: r._id, no: r['商机编号'], name: r['商机名称'], customerNo: r['客户编号'] || '', customerName: r['客户名称'] || '',
              stage: r['阶段'] || '', amount: Number(r['商机金额万元']) || 0, expected: normDate(r['预计落单时间']),
              source: r['来源'] || '',
              contact: r['联系人'] || '', phone: r['联系电话'] || '', intro: r['简介'] || '',
              seller: r['销售姓名'] || '', owner: r['售前姓名'] || '', winRate: r['赢单率'] == null ? null : Number(r['赢单率']),
              lastFollow: normDate(r['最后跟进时间']),
            }, followups: followups.filter((f) => (f['商机'] || []).includes(r._id)).map((f) => ({
              no: f['跟进编号'], date: normDate(f['跟进日期']), person: f['跟进人'] || '', way: f['方式'] || '',
              content: f['内容'] || '', next: f['下一步'] || '', nextDate: normDate(f['下次跟进']),
            })), changes: changes.filter((c) => (c['商机'] || []).includes(r._id)).map((c) => ({
              date: String(c['变更时间'] || '').slice(0, 10), by: c['变更人'] || '', field: c['字段'] || '', old: c['原值'] || '', val: c['新值'] || '', reason: c['原因'] || '',
            })), quotes: qs, documents: docs })
          }
          if (route === 'opp_board') {
            const rows = await list('opportunities')
            const agg = (key) => {
              const m = new Map()
              for (const r of rows) {
                const k = r[key] || '未填'
                const v = m.get(k) || { n: 0, amount: 0 }
                v.n += 1; v.amount += Number(r['商机金额万元']) || 0
                m.set(k, v)
              }
              return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount)
            }
            const total = rows.length
            const won = rows.filter((r) => r['阶段'] === '赢单').length
            return json(res, 200, { ok: true, total, amount: rows.reduce((s, r) => s + (Number(r['商机金额万元']) || 0), 0), won, stages: agg('阶段'), sources: agg('来源'), top: rows.slice().sort((a, b) => (Number(b['商机金额万元']) || 0) - (Number(a['商机金额万元']) || 0)).slice(0, 5).map((r) => ({ no: r['商机编号'], name: r['商机名称'], amount: Number(r['商机金额万元']) || 0, stage: r['阶段'] })) })
          }
          if (route === 'opp_update' && req.method === 'POST') {
            try {
              const b = await readBody(req)
              const rows = await list('opportunities')
              const r = rows.find((x) => x['商机编号'] === b.no)
              if (!r) return json(res, 404, { ok: false, error: '商机不存在' })
              const f = b.fields || {}
              if (f.stage && !OPP_STAGES.includes(f.stage)) return json(res, 400, { ok: false, error: `阶段必须是：${OPP_STAGES.join('、')}` })
              const patch = {}
              const map = { name: '商机名称', amount: '商机金额万元', stage: '阶段', expected: '预计落单时间', source: '来源', contact: '联系人', phone: '联系电话', seller: '销售姓名', owner: '售前姓名', intro: '简介' }
              for (const [k, field] of Object.entries(map)) if (f[k] !== undefined) patch[field] = k === 'amount' ? Number(f[k]) || 0 : f[k]
              if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可更新字段' })
              await updateRecord('opportunities', r._id, patch)
              if (f.stage && f.stage !== r['阶段']) {
                await logOppChange({ oppId: r._id, oppNo: r['商机编号'], field: '阶段', oldValue: r['阶段'] || '', newValue: f.stage, reason: '人工编辑', by: '' })
              }
              return json(res, 200, { ok: true })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'opp_stage' && req.method === 'POST') {
            const body = await readBody(req)
            if (!OPP_STAGES.includes(body.stage)) return json(res, 400, { ok: false, error: '非法阶段' })
            const rows = await list('opportunities')
            const r = rows.find((x) => x['商机编号'] === body.no)
            if (!r) return json(res, 404, { ok: false, error: '商机不存在' })
            await updateRecord('opportunities', r._id, { '阶段': body.stage })
            await logOppChange({ oppId: r._id, oppNo: body.no, field: '阶段', oldValue: r['阶段'], newValue: body.stage, reason: body.reason, by: '' })
            return json(res, 200, { ok: true, stage: body.stage })
          }
          if (route === 'opp_followup' && req.method === 'POST') {
            const body = await readBody(req)
            const rows = await list('opportunities')
            const r = rows.find((x) => x['商机编号'] === body.no)
            if (!r) return json(res, 404, { ok: false, error: '商机不存在' })
            const d = body.date || today()
            await create('oppFollowups', [{
              '跟进编号': `${body.no}-F${Date.now()}`, '商机': [r._id], '跟进日期': d,
              '跟进人': body.person || '', '方式': body.way || '其他', '内容': body.content || '',
              '下一步': body.next || '', '下次跟进': body.nextDate || '',
            }])
            await updateRecord('opportunities', r._id, { '最后跟进时间': d })
            return json(res, 200, { ok: true })
          }
          if (route === 'email_accounts') {
            try { return json(res, 200, { ok: true, ...(await emailAccounts()) }) } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_draft' && req.method === 'POST') {
            try {
              const body = await readBody(req)
              const mail = await rfqMailPreview(String(body.id || ''))
              const draft = await callHostTool('email_draft', {
                account: body.account || '',
                to: body.to || mail.to || '',
                subject: mail.subject,
                text: mail.text,
              })
              return json(res, 200, { ok: true, draft })
            } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_sync' && req.method === 'POST') {
            try { return json(res, 200, { ok: true, ...(await syncRfqReplies(30)) }) } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_create' && req.method === 'POST') {
            try { const body = await readBody(req); return json(res, 200, { ok: true, ...(await createRfqBatch(body)) }) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_list') {
            try { return json(res, 200, { ok: true, items: await listRfqs() }) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'open_mailto' && req.method === 'POST') {
            try {
              const body = await readBody(req)
              const url = `mailto:?subject=${encodeURIComponent(String(body.subject || ''))}&body=${encodeURIComponent(String(body.text || '').slice(0, 1500))}`
              const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open')
              const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
              await new Promise((resolve, reject) => execFile(cmd, args, { timeout: 10000 }, (err) => err ? reject(err) : resolve()))
              return json(res, 200, { ok: true })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_update' && req.method === 'POST') {
            try { const body = await readBody(req); return json(res, 200, await updateRfqHeader(String(body.id || ''), body)) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_item_price' && req.method === 'POST') {
            try { const body = await readBody(req); return json(res, 200, await applyRfqItemPrice(String(body.itemId || ''), body.price)) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_detail') {
            try { return json(res, 200, { ok: true, ...(await rfqDetail(String(url.searchParams.get('id') || ''))) }) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_mail') {
            try { return json(res, 200, { ok: true, ...(await rfqMailPreview(String(url.searchParams.get('id') || ''))) }) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_sent' && req.method === 'POST') {
            try { const body = await readBody(req); return json(res, 200, await markRfqSent(String(body.id || ''), body)) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'rfq_reply' && req.method === 'POST') {
            try { const body = await readBody(req); return json(res, 200, await replyRfq(String(body.id || ''), body)) } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'template_sections') {
            try { return json(res, 200, { ok: true, sections: await templateSections(String(url.searchParams.get('template') || '')) }) } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'template_check') {
            try { return json(res, 200, { ok: true, ...(await checkTemplateFiles()) }) } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'template_sync' && req.method === 'POST') {
            try { return json(res, 200, { ok: true, ...(await syncTemplateFiles()) }) } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'template_local' && req.method === 'POST') {
            try {
              const body = await readBody(req)
              return json(res, 200, { ok: true, ...(await saveLocalTemplate(body)) })
            } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'download') {
            const name = url.searchParams.get('f') || ''
            const file = path.join(path.resolve(config.outputDir || path.join(homedir(), '.dsh', 'presales-out', 'quotes')), path.basename(name))
            try {
              const buf = await readFile(file)
              res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` })
              res.end(buf)
            } catch { res.writeHead(404).end('not found') }
            return
          }
          if (route === 'customer_prompt') {
            return json(res, 200, { ok: true, prompt: NEW_CUSTOMER_PROMPT })
          }
          if (route === 'skill_prompt') {
            return json(res, 200, { ok: true, prompt: NEW_OPP_PROMPT })
          }
          if (route === 'update_check') {
            return json(res, 200, { ok: true, repos: await checkUpdates() })
          }
          if (route === 'update' && req.method === 'POST') {
            const body = await readBody(req)
            try {
              const out = await updatePlugin(body.key)
              return json(res, 200, { ok: true, ...out })
            } catch (e) {
              return json(res, 400, { ok: false, error: String(e && e.message ? e.message : e) })
            }
          }
          if (route === 'current_user') {
            return json(res, 200, { ok: true, ...(await currentUser()) })
          }
          if (route === 'industry_options') {
            return json(res, 200, { ok: true, items: GB_INDUSTRIES })
          }
          if (route === 'dev_list') {
            try {
              const rows = await list('devEvals')
              const items = rows.map((r) => ({ id: r._id, no: r['评估编号'], opportunityNo: r['商机编号'] || '', opportunityName: r['商机名称'] || '', customerName: r['客户名称'] || '', stage: r['商机阶段'] || '', presale: r['售前'] || '', owner: r['评估负责人'] || '', version: Number(r['版本']) || 1, summary: r['评估结果摘要'] || '', createdAt: normDate(r['生成时间']), createdAtRaw: r['生成时间'] || '', works: (() => { try { return JSON.parse(r['工作类'] || '[]') } catch { return [] } })() }))
              return json(res, 200, { ok: true, items })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'dev_get') {
            try {
              const key = String(url.searchParams.get('key') || '')
              const rows = await list('devEvals')
              const r = rows.find((x) => x._id === key || x['评估编号'] === key)
              if (!r) return json(res, 404, { ok: false, error: '评估不存在' })
              return json(res, 200, { ok: true, item: { id: r._id, no: r['评估编号'], opportunityNo: r['商机编号'] || '', opportunityName: r['商机名称'] || '', customerName: r['客户名称'] || '', stage: r['商机阶段'] || '', presale: r['售前'] || '', owner: r['评估负责人'] || '', version: Number(r['版本']) || 1, summary: r['评估结果摘要'] || '', createdAt: normDate(r['生成时间']), createdAtRaw: r['生成时间'] || '', works: (() => { try { return JSON.parse(r['工作类'] || '[]') } catch { return [] } })() } })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'dev_save' && req.method === 'POST') {
            try {
              const b = await readBody(req)
              const works = Array.isArray(b.works) ? b.works : []
              const base = { '商机编号': b.opportunityNo || '', '商机名称': b.opportunityName || '', '客户名称': b.customerName || '', '商机阶段': b.stage || '', '售前': b.presale || '', '评估负责人': b.owner || '', '评估结果摘要': b.summary || '', '工作类': JSON.stringify(works), '生成时间': new Date().toISOString().slice(0, 16).replace('T', ' ') }
              if (b.id) {
                const rows = await list('devEvals'); const r = rows.find((x) => x._id === b.id)
                if (!r) return json(res, 404, { ok: false, error: '评估不存在' })
                const version = (Number(r['版本']) || 1) + 1
                await updateRecord('devEvals', b.id, { ...base, '版本': version })
                return json(res, 200, { ok: true, id: b.id, no: r['评估编号'], version })
              }
              const rows = await list('devEvals'); const year = new Date().getFullYear(); let max = 0
              for (const r of rows) { const m = String(r['评估编号'] || '').match(/PG-(\d{4})-(\d+)/); if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2])) }
              const no = `PG-${year}-${String(max + 1).padStart(4, '0')}`
              const [id] = await create('devEvals', [{ ...base, '评估编号': no, '版本': 1 }])
              return json(res, 200, { ok: true, id, no, version: 1 })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'dev_delete' && req.method === 'POST') {
            try {
              const b = await readBody(req)
              await deleteRecord('devEvals', b.id)
              return json(res, 200, { ok: true })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'customer_get') {
            try {
              const key = String(url.searchParams.get('key') || '')
              const rows = await list('customers')
              const c = rows.find((x) => x._id === key || x['客户编号'] === key || x['客户名称'] === key)
              if (!c) return json(res, 404, { ok: false, error: '客户不存在' })
              const [opps, quotes] = await Promise.all([list('opportunities'), list('quotes')])
              const relatedOpps = opps.filter((o) => {
                const sameName = !!o['客户名称'] && o['客户名称'] === c['客户名称']
                const sameCode = o['客户编号'] === c['客户编号'] && (!o['客户名称'] || o['客户名称'] === c['客户名称'])
                return sameName || sameCode
              })
              const relatedQuotes = quotes.filter((q) => q['客户名称'] === c['客户名称'] || q['客户编号'] === c['客户编号'])
              return json(res, 200, { ok: true, customer: c, opportunities: relatedOpps, quotes: relatedQuotes })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'customer_lookup') {
            try {
              const name = String(url.searchParams.get('name') || '').trim()
              const region = String(url.searchParams.get('region') || '').trim()
              if (!name) return json(res, 400, { ok: false, error: '请先填客户名称' })
              const q = `${name} ${region} 工商信息 法定代表人 注册资本 成立日期 注册地址`
              let searched
              try {
                const web = typeof ctx.get === 'function' ? ctx.get('web') : null
                if (web && typeof web.search === 'function') {
                  const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? AbortSignal.timeout(25000) : undefined
                  const r = await web.search({ query: q, maxResults: 5 }, signal)
                  searched = { answer: r.content || '', sources: r.sources || [] }
                } else {
                  searched = await callHostTool('web_search', { queries: [q] })
                }
              } catch (e) { return json(res, 500, { ok: false, error: `联网搜索不可用：${e.message}` }) }
              const sources = (searched.sources || []).slice(0, 5).map((x) => ({ title: x.title, url: x.url, snippet: x.snippet || '' }))
              const text = [searched.answer || searched.content || '', ...sources.map((x) => `${x.title || ''}\n${x.snippet || ''}`)].join('\n')
              const pick = (re) => { const m = text.match(re); return m ? m[1].trim().replace(/[，,。；;]$/, '') : '' }
              const fields = {
                '法定代表人': pick(/法定代表人[：:\s]*([^\s，,。；;\n]{2,12})/),
                '注册资本': pick(/注册资本[：:\s]*([0-9.,]+[万亿]?[元人民币]*)/),
                '成立时间': pick(/成立(?:日期|时间)[：:\s]*(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?)/),
                '地址': pick(/(?:注册地址|地址)[：:\s]*为?([^\n，,。；;]{6,80})/),
              }
              if (fields['成立时间']) {
                const dm = String(fields['成立时间']).match(/(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})/)
                if (dm) fields['成立时间'] = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`
              }
              const addr = fields['地址'] || ''
              if (addr) {
                const rm = addr.replace(/^中国/, '').match(/^(.+?(?:特别行政区|自治区|省|市))/)
                if (rm) fields['省市'] = rm[1]
              }
              const industryRaw = pick(/所属行业(?:为)?([^，,。；;\n]{2,30})/)
              if (industryRaw) {
                const hit = GB_INDUSTRIES.find((x) => industryRaw.includes(x.name) || x.name.includes(industryRaw))
                if (hit) fields['行业分类'] = `${hit.group} ${hit.groupName} / ${hit.code} ${hit.name}`
              }
              for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k]
              if (!fields['客户简介']) {
                const biz = pick(/经营范围[：:\s]*([^\n]{10,200})/) || pick(/主营业务[：:\s]*([^\n]{10,200})/)
                const sentences = text.split(/[。\n]/).map((x) => x.trim()).filter((x) => x.length >= 8 && x.length <= 120)
                const safety = sentences.find((x) => x.includes('安全生产') && !/法定代表人|注册资本|注册地址|成立日期/.test(x))
                const tech = sentences.find((x) => /(数字化|智能化|信息化|软件|系统集成|解决方案)/.test(x) && !/法定代表人|注册资本|注册地址|成立日期/.test(x))
                const parts = []
                if (biz) parts.push(`${name}主要从事${biz.replace(/[，,。；;]$/, '')}。`)
                if (safety && (biz ? !biz.includes('安全生产') : true)) parts.push(`${safety.replace(/^[^，。]*?公司/, name)}。`)
                if (!parts.length && tech) parts.push(`${tech.replace(/^[^，。]*?公司/, name)}。`)
                if (!parts.length) {
                  const ind = fields['行业分类'] ? String(fields['行业分类']).split('/').pop().trim() : ''
                  parts.push(`${name}是一家${ind ? '从事' + ind + '相关业务' : '专注于行业数字化'}的企业。`)
                }
                fields['客户简介'] = parts.join('')
              }
              return json(res, 200, { ok: true, fields, sources, answer: String(searched.answer || '').slice(0, 1200), note: '联网结果仅供核对，需人工确认后保存' })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'customer_delete' && req.method === 'POST') {
            try {
              const body = await readBody(req)
              if (!body.id) return json(res, 400, { ok: false, error: '缺少客户 id' })
              await deleteRecord('customers', body.id)
              return json(res, 200, { ok: true })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'customer_save' && req.method === 'POST') {
            try {
              const body = await readBody(req)
              if (!String(body['客户名称'] || '').trim()) return json(res, 400, { ok: false, error: '客户名称必填' })
              if (body.id) {
                const patch = {}
                for (const k of ['客户名称','省市','行业分类','法定代表人','注册资本','成立时间','地址','客户简介','创建人','状态']) {
                  if (body[k] !== undefined) patch[k] = body[k]
                }
                await updateRecord('customers', body.id, patch)
                return json(res, 200, { ok: true, id: body.id })
              }
              const rows = await list('customers')
              const year = new Date().getFullYear()
              let max = 0
              for (const r of rows) {
                const m = String(r['客户编号'] || '').match(/C-(\d{4})-(\d+)/)
                if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]))
              }
              const no = `C-${year}-${String(max + 1).padStart(4, '0')}`
              const row = {
                '客户编号': no, '客户名称': String(body['客户名称']).trim(),
                '省市': body['省市'] || '',
                '行业分类': body['行业分类'] || '', '法定代表人': body['法定代表人'] || '', '注册资本': body['注册资本'] || '',
                '成立时间': body['成立时间'] || '', '地址': body['地址'] || '', '客户简介': body['客户简介'] || '', '创建人': body['创建人'] || (await currentUser()).name || '',
                '创建人': body['创建人'] || '', '状态': body['状态'] || '正常',
              }
              const clean = {}
              for (const [k, v] of Object.entries(row)) { if (v !== null && v !== undefined && v !== '') clean[k] = v }
              const [id] = await create('customers', [clean])
              return json(res, 200, { ok: true, id, no })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'bootstrap') {
            const r = await ready()
            if (r.error) return json(res, 200, { ok: false, error: r.error })
            try {
              const [products, customers, opportunities, quotes, templates, categories, modules] = await Promise.all([
                list('products'), list('customers'), list('opportunities'), list('quotes'), list('quoteTemplates'), list('productCategories'), list('productModules'),
              ])
              const catById = new Map(categories.map((c) => [c._id, c['分类名称']]))
              const norm = (v) => Array.isArray(v) ? v : (v ? [v] : [])
              const ones = categories.filter((c) => c['层级'] === '一级')
              const countL1 = new Map(); const countL2 = new Map()
              for (const p of products) {
                const l1 = catById.get((p['一级分类'] || [])[0]) || ''
                const l2 = catById.get((p['二级分类'] || [])[0]) || ''
                countL1.set(l1, (countL1.get(l1) || 0) + 1)
                countL2.set(`${l1}||${l2}`, (countL2.get(`${l1}||${l2}`) || 0) + 1)
              }
              const tree = ones.map((c) => ({
                id: c._id, name: c['分类名称'], count: countL1.get(c['分类名称']) || 0,
                children: categories.filter((x) => x['层级'] === '二级' && norm(x['父记录']).includes(c._id))
                  .map((x) => ({ id: x._id, name: x['分类名称'], count: countL2.get(`${c['分类名称']}||${x['分类名称']}`) || 0 })),
              }))
              return json(res, 200, {
                ok: true,
                status: { ok: true, counts: { products: products.length, customers: customers.length, opportunities: opportunities.length, quotes: quotes.length, quoteTemplates: templates.length } },
                customers: customers.map((c) => {
                  const oppCount = opportunities.filter((o) => {
                    const sameName = !!o['客户名称'] && o['客户名称'] === c['客户名称']
                    const sameCode = o['客户编号'] === c['客户编号'] && (!o['客户名称'] || o['客户名称'] === c['客户名称'])
                    return sameName || sameCode
                  }).length
                  return { id: c._id, code: c['客户编号'] || '', name: c['客户名称'] || '', region: c['省市'] || '', industryCategory: c['行业分类'] || '', legal: c['法定代表人'] || '', capital: c['注册资本'] || '', founded: normDate(c['成立时间']), address: c['地址'] || '', intro: c['客户简介'] || '', creator: c['创建人'] || '', createdAt: normDate(c['创建时间']), oppCount, status: c['状态'] || '' }
                }),
                templates: templates.filter((t) => t['启用状态'] === '启用').map((t) => ({ name: t['模板名称'], type: t['模板类型'], default: Boolean(t['默认模板']), fileId: t['文件ID'] || '' })),
                quotes: quotes.slice().sort((a, b) => String(b['更新时间'] || b['创建时间'] || '').localeCompare(String(a['更新时间'] || a['创建时间'] || ''))).map((q) => {
                  const o = opportunities.find((x) => x['商机编号'] === q['商机编号'])
                  return {
                    quoteNo: q['报价单号'], opportunityNo: q['商机编号'] || '', opportunityName: q['商机名称'] || o?.['商机名称'] || '',
                    customerName: q['客户名称'] || '', seller: o?.['销售姓名'] || '', owner: o?.['售前姓名'] || '',
                    status: q['状态'] || '', grossTotal: Number(q['含税合计']) || 0, margin: q['毛利率'] == null ? null : Number(q['毛利率']),
                    version: q['当前版本'] || '', updated: normDate(q['更新时间'] || q['创建时间']), link: q['文件链接'] || '', template: q['模板'] || '',
                  }
                }),
                categories: tree,
                currentUser: await currentUser(),
              })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'status') {
            const r = await ready()
            if (r.error) return json(res, 200, { ok: false, error: r.error, counts: {} })
            const counts = {}
            for (const alias of ['products', 'customers', 'opportunities', 'quotes', 'quoteTemplates']) {
              try { counts[alias] = (await list(alias)).length } catch { counts[alias] = null }
            }
            return json(res, 200, { ok: true, counts })
          }
          if (route === 'customers') {
            const rows = await list('customers')
            return json(res, 200, { ok: true, items: rows.map((r) => ({
              id: r._id, code: r['客户编号'] || '', name: r['客户名称'] || '', industry: r['行业分类'] || '', level: r['客户等级'] || '',
            })) })
          }
          if (route === 'opportunities') {
            const cid = url.searchParams.get('customerId') || ''
            const [rows, customers] = await Promise.all([list('opportunities'), list('customers')])
            const c = customers.find((x) => x._id === cid)
            const items = rows.filter((r) => !c || r['客户编号'] === c['客户编号'] || r['客户名称'] === c['客户名称'])
            return json(res, 200, { ok: true, items: items.map((r) => ({
              id: r._id, no: r['商机编号'] || '', name: r['商机名称'] || '', stage: r['阶段'] || '', amount: r['预计金额'] || null,
            })) })
          }
          if (route === 'categories') {
            const cats = await list('productCategories')
            const catalog = await loadCatalog()
            const countL1 = new Map(); const countL2 = new Map()
            for (const p of catalog) {
              countL1.set(p.l1, (countL1.get(p.l1) || 0) + 1)
              const key = `${p.l1}||${p.l2}`; countL2.set(key, (countL2.get(key) || 0) + 1)
            }
            const norm = (v) => Array.isArray(v) ? v : (v ? [v] : [])
            const ones = cats.filter((c) => c['层级'] === '一级')
            const tree = ones.map((c) => ({
              id: c._id, name: c['分类名称'], count: countL1.get(c['分类名称']) || 0,
              children: cats.filter((x) => x['层级'] === '二级' && norm(x['父记录']).includes(c._id))
                .map((x) => ({ id: x._id, name: x['分类名称'], count: countL2.get(`${c['分类名称']}||${x['分类名称']}`) || 0 })),
            }))
            return json(res, 200, { ok: true, tree })
          }
          if (route === 'products') {
            const kw = String(url.searchParams.get('keyword') || '').toLowerCase()
            const l1 = String(url.searchParams.get('l1') || '')
            const l2 = String(url.searchParams.get('l2') || '')
            const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50)
            const catalog = await loadCatalog()
            let rows = catalog.filter((p) => isQuotable(p))
            if (l1) rows = rows.filter((p) => p.l1 === l1)
            if (l2) rows = rows.filter((p) => p.l2 === l2)
            if (kw) rows = rows.filter((p) => `${p.code} ${p.name} ${p.brand} ${p.model} ${p.l2}`.toLowerCase().includes(kw))
            return json(res, 200, { ok: true, items: rows.slice(0, limit).map((p) => ({
              code: p.code, name: p.name, unit: p.unit, stdPrice: p.stdPrice, costPrice: p.costPrice,
              taxRate: p.taxRate, minDiscount: p.minDiscount, spec: p.spec, brand: p.brand, model: p.model, l2: p.l2,
            })) })
          }
          if (route === 'templates') {
            const rows = await list('quoteTemplates')
            return json(res, 200, { ok: true, items: rows.filter((r) => r['启用状态'] === '启用').map((r) => ({
              name: r['模板名称'], type: r['模板类型'], default: Boolean(r['默认模板']), fileId: r['文件ID'] || '',
            })) })
          }
          if (route === 'quotes') {
            const [quotes, versions] = await Promise.all([list('quotes'), list('quoteVersions')])
            const items = quotes.slice(-10).reverse().map((q) => ({
              quoteNo: q['报价单号'], customerName: q['客户名称'] || '', status: q['状态'] || '',
              grossTotal: Number(q['含税合计']) || 0, version: q['当前版本'] || '',
              link: q['文件链接'] || '',
              versionCount: versions.filter((v) => (v['报价单'] || []).includes(q._id)).length,
            }))
            return json(res, 200, { ok: true, items })
          }
          if (route === 'render' && req.method === 'POST') {
            const body = await readBody(req)
            if (!body.quoteNo) return json(res, 400, { ok: false, error: '缺少 quoteNo' })
            const loaded = await loadQuoteDto(body.quoteNo)
            const out = await renderQuoteXlsx(loaded, loaded.meta)
            return json(res, 200, { ok: true, ...out })
          }
          if (route === 'quote_latest') {
            try {
              const quoteNo = String(url.searchParams.get('quoteNo') || '')
              const oppNo = String(url.searchParams.get('opportunityNo') || '')
              const customerName = String(url.searchParams.get('customerName') || '')
              const quotes = await list('quotes')
              const q = quoteNo ? quotes.find((x) => x['报价单号'] === quoteNo) : quotes.filter((x) => (oppNo && x['商机编号'] === oppNo) || (!oppNo && customerName && x['客户名称'] === customerName)).slice(-1)[0]
              if (!q) return json(res, 200, { ok: true, quote: null })
              const dto = await loadQuoteDto(q['报价单号'])
              return json(res, 200, { ok: true, quote: { quoteNo: q['报价单号'], currentVersion: q['当前版本'] || 'V1', template: q['模板'] || '', lines: dto.lines } })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'quote_revise' && req.method === 'POST') {
            try {
              const b = await readBody(req)
              const quoteNo = String(b.quoteNo || '')
              const [quotes, versions] = await Promise.all([list('quotes'), list('quoteVersions')])
              const q = quotes.find((x) => x['报价单号'] === quoteNo)
              if (!q) return json(res, 404, { ok: false, error: '报价单不存在' })
              const vs = versions.filter((v) => (v['报价单'] || []).includes(q._id)).sort((a, c) => Number(a['版本号']) - Number(c['版本号']))
              const last = vs[vs.length - 1]
              const nextNo = (Number(last?.['版本号']) || 1) + 1
              const prevDto = await loadQuoteDto(quoteNo)
              const { lines, violations } = await buildQuoteLinesFromItems(b.items || [])
              if (violations.length) return json(res, 400, { ok: false, error: violations.map((v) => v.message).join('；') })
              const dto = buildQuoteDto({ lines, meta: { customerName: q['客户名称'] || '', customerNo: q['客户编号'] || '', opportunityNo: q['商机编号'] || '', opportunityName: q['商机名称'] || '' } })
              const changes = diffLines(prevDto.lines, lines)
              const version = `V${nextNo}`
              const changeText = [changes.join('；'), b.note || ''].filter(Boolean).join('；') || '重出报价单'
              const [versionId] = await create('quoteVersions', [{
                '版本标识': `${quoteNo}-${version}`, '报价单': [q._id], '报价单号': quoteNo, '版本号': nextNo,
                '状态': '草稿', '模板': q['模板'] || '', '提交时间': today(), '有效期至': last?.['有效期至'] || '',
                '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal, '含税合计': dto.totals.grossTotal,
                '成本合计': dto.totals.costTotal, '毛利额': dto.totals.profit, '毛利率': dto.totals.margin ?? '', '变更说明': changeText,
              }])
              await create('quoteItems', lines.map((l) => ({
                '行标识': `${quoteNo}-${version}-${String(l.lineNo).padStart(2, '0')}`, '报价版本': [versionId], '版本标识': `${quoteNo}-${version}`,
                '序号': l.lineNo, '分节': l.section || '一、产品报价', '产品编码': l.code, '产品名称': l.name,
                '规格': l.spec, '品牌': l.brand, '型号': l.model, '单位': l.unit, '数量': l.qty,
                '标准未税单价': l.stdPrice, '折扣': l.discount, '不含税单价': l.untaxedUnit, '税率': l.taxRate,
                '税额': l.tax, '含税单价': l.grossUnit, '不含税小计': l.untaxedSubtotal, '含税小计': l.grossSubtotal, '备注': l.remark || '',
                '行类型': l.lineType || '目录产品', '询价编号': l.rfqNo || '', '价格状态': l.priceStatus || '已定价',
              })))
              let link = ''
              try {
                const rendered = await renderByTemplate(dto, { quoteNo, version, date: today(), customerName: dto.customerName, validUntil: last?.['有效期至'] || '' }, q['模板'])
                link = rendered.link || ''
                await updateRecord('quotes', q._id, { '当前版本': version, '不含税合计': dto.totals.untaxedTotal, '税额合计': dto.totals.taxTotal, '含税合计': dto.totals.grossTotal, '毛利率': dto.totals.margin ?? '', '文件链接': link })
                await registerDocument({ quoteNo, version, customerName: dto.customerName, opportunityNo: dto.opportunityNo, opportunityName: dto.opportunityName, fileName: rendered.name, link })
              } catch { /* 出单失败不影响版本 */ }
              return json(res, 200, { ok: true, quoteNo, version, link, grossTotal: dto.totals.grossTotal, changes: changeText })
            } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }) }
          }
          if (route === 'save' && req.method === 'POST') {
            const body = await readBody(req)
            const { lines, violations } = await buildQuoteLinesFromItems(body.items || [])
            if (violations.length) return json(res, 400, { ok: false, error: violations.map((v) => v.message).join('；') })
            const dto = buildQuoteDto({ lines, meta: { customerName: body.customerName || '', customerNo: body.customerNo || '', opportunityNo: body.opportunityNo || '' } })
            const out = await persistQuote(dto, { template: body.template })
            let rendered = null
            try {
              if (body.localTemplateId) {
                rendered = await renderLocalTemplate(dto, { quoteNo: out.quoteNo, version: 'V1', date: today(), customerName: dto.customerName }, body.localTemplateId)
                if (out.quoteId) await updateRecord('quotes', out.quoteId, { '文件链接': rendered.link })
              } else {
                rendered = await renderByTemplate(dto, { quoteNo: out.quoteNo, version: 'V1', date: today(), customerName: dto.customerName, validUntil: '' }, body.template)
                if (rendered?.link && out.quoteId) await updateRecord('quotes', out.quoteId, { '文件链接': rendered.link })
                await registerDocument({ quoteNo: out.quoteNo, version: 'V1', customerName: dto.customerName, opportunityNo: dto.opportunityNo, opportunityName: dto.opportunityName, fileName: rendered?.name, link: rendered?.link })
              }
            } catch { /* 出单失败不影响落库 */ }
            return json(res, 200, { ok: true, ...out, link: rendered?.link || '', fileName: rendered?.name || '' })
          }
          return json(res, 404, { ok: false, error: `unknown api route: ${route}` })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        }
      },
    })
    if (typeof runtime.effect === 'function') runtime.effect(() => dispose)
  }

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountPanel)
  else mountPanel(ctx)

  register({
    name: 'quote_render_xlsx',
    description: '把报价写成 WPS Excel（复制版式到报价管理/报价单/），可传 quoteNo 或 dto；返回文件链接。',
    parameters: {
      type: 'object',
      properties: {
        quoteNo: { type: 'string', description: '已落库的报价单号，如 BJ-2026-0003' },
        dto: { type: 'object', description: '未落库的 DTO（可选）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      let dto = args.dto
      let meta
      if (!dto) {
        if (!args.quoteNo) return '请提供 quoteNo 或 dto。'
        const loaded = await loadQuoteDto(args.quoteNo)
        dto = loaded
        meta = loaded.meta
      } else {
        meta = { quoteNo: args.quoteNo || `DRAFT-${Date.now()}`, date: today(), customerName: dto.customerName || '' }
      }
      const out = await renderQuoteXlsx(dto, meta)
      return `✅ 已生成 Excel 报价单：${out.name}\n文件 ID：${out.fileId}\n链接：${out.link}`
    },
  })

  register({
    name: 'quote_render_markdown',
    description: '把报价 DTO 渲染成 Markdown 报价单（按分节分组），写入工作区 out/quotes/。',
    parameters: {
      type: 'object',
      properties: {
        dto: { type: 'object' },
        quoteNo: { type: 'string', description: '可选，用于文件名与标题' },
      },
      required: ['dto'],
    },
    output: TEXT_OUTPUT,
    async execute(args = {}) {
      const dto = args.dto
      if (!dto || !Array.isArray(dto.lines)) return '缺少 dto。'
      const quoteNo = args.quoteNo || `DRAFT-${Date.now()}`
      const dir = path.resolve(config.outputDir || path.join(homedir(), '.dsh', 'presales-out', 'quotes'))
      await mkdir(dir, { recursive: true })
      const bySection = new Map()
      for (const l of dto.lines) {
        const s = l.section || '一、产品报价'
        if (!bySection.has(s)) bySection.set(s, [])
        bySection.get(s).push(l)
      }
      const lines = [
        `# 信云智联 ${dto.customerName || '××项目'} 报价单`,
        '',
        `> 报价单号：${quoteNo} · 日期：${today()} · 客户：${dto.customerName || '-'}`,
        '',
        '| 序号 | 产品名称 | 规格/型号 | 单位 | 数量 | 含税单价 | 含税小计 |',
        '|---|---|---|---|---|---|---|',
      ]
      let n = 0
      for (const [section, items] of bySection) {
        lines.push(`| **${section}** | | | | | | |`)
        for (const l of items) {
          n += 1
          lines.push(`| ${n} | ${l.name} | ${[l.spec, l.brand, l.model].filter(Boolean).join(' / ')} | ${l.unit} | ${l.qty} | ${fmt(l.grossUnit)} | ${fmt(l.grossSubtotal)} |`)
        }
      }
      const t = dto.totals
      lines.push('', `**未税合计** ${fmt(t.untaxedTotal)}　**税额** ${fmt(t.taxTotal)}　**含税合计** ${fmt(t.grossTotal)}`, '')
      lines.push('> 人民币：元，含税价。本报价单由售前数字员工生成，仅供研究/商务沟通使用。')
      const file = path.join(dir, `${quoteNo}.md`)
      await writeFile(file, lines.join('\n'), 'utf8')
      return `已生成：${file}`
    },
  })
}
