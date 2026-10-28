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
import { PRESALES_SKILL, NEW_OPP_PROMPT } from './lib/skill.js'

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
      source: '来源', industryL1: '行业门类（一级）', industryL2: '行业大类（二级）',
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
        `行业：${r['行业门类（一级）'] || '-'} / ${r['行业大类（二级）'] || '-'} ｜ 销售：${r['销售姓名'] || '-'} ｜ 售前：${r['售前姓名'] || '-'}`,
        `预计落单：${String(r['预计落单时间'] || '-').slice(0, 10)} ｜ 最后跟进：${String(r['最后跟进时间'] || '-').slice(0, 10)} ｜ 来源：${r['来源'] || '-'}`,
        r['简介'] ? `简介：${r['简介']}` : '',
        `跟进记录（${fs.length}）：`,
        ...fs.slice(0, 5).map((f) => `- ${String(f['跟进日期'] || '').slice(0, 10)} ${f['方式'] || ''} ${f['跟进人'] || ''}：${String(f['内容'] || '').slice(0, 60)}`),
        `变更记录（${cs.length}）：`,
        ...cs.slice(0, 5).map((c) => `- ${String(c['变更时间'] || '').slice(0, 10)} ${c['字段']}：${c['原值']} → ${c['新值']}`),
      ].filter(Boolean).join('\n')
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
        industryL1: { type: 'string' }, industryL2: { type: 'string' },
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
        '来源': args.source || '主动开发', '行业门类（一级）': args.industryL1 || '', '行业大类（二级）': args.industryL2 || '',
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
        ...by('行业门类（一级）').slice(0, 8).map(([k, v]) => `- ${k}：${v.n} 个 / ${v.amt.toFixed(0)} 万`),
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
        const rendered = await renderQuoteXlsx(dto, { quoteNo, version: 'V1', date: today(), customerName: dto.customerName || '', validUntil })
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
      })))
      let link = ''
      try {
        const rendered = await renderQuoteXlsx(dto, { quoteNo, version, date: today(), customerName: dto.customerName, validUntil: last?.['有效期至'] || '' })
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

  async function loadQuoteDto(quoteNo) {
    const [quotes, versions, items] = await Promise.all([list('quotes'), list('quoteVersions'), list('quoteItems')])
    const q = quotes.find((x) => x['报价单号'] === quoteNo)
    if (!q) throw new Error(`未找到报价单 ${quoteNo}`)
    const vs = versions.find((v) => (v['报价单'] || []).includes(q._id))
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

  async function ghLatest(repo) {
    const headers = { 'user-agent': 'dsh-presales-updater', accept: 'application/vnd.github+json' }
    if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers })
    if (!r.ok) throw new Error(`GitHub ${r.status}`)
    const d = await r.json()
    const asset = (d.assets || []).find((a) => String(a.name).endsWith('.tgz'))
    return { tag: d.tag_name, published: d.published_at, asset: asset ? { name: asset.name, url: asset.browser_download_url } : null }
  }

  async function checkUpdates() {
    const out = []
    for (const [key, repo] of Object.entries(config.updateRepos || {})) {
      if (!repo) continue
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
    const res = await fetch(latest.asset.url, { headers: { 'user-agent': 'dsh-presales-updater' } })
    if (!res.ok) throw new Error(`下载失败 ${res.status}`)
    const file = path.join(tmpdir(), latest.asset.name)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
    const profile = process.env.DSH_PROFILE || 'desktop'
    const candidates = [process.env.DSH_CLI, 'dsh', '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'].filter(Boolean)
    let lastError = null
    for (const dsh of candidates) {
      try {
        await execFileAsync(dsh, ['plugin', '--profile', profile, 'add', file], { timeout: 300000 })
        lastError = null
        break
      } catch (e) { lastError = e }
    }
    if (lastError) throw lastError
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
          if (route === 'opps') {
            const kw = String(url.searchParams.get('keyword') || '').toLowerCase()
            const stage = url.searchParams.get('stage') || ''
            let rows = await list('opportunities')
            if (stage) rows = rows.filter((r) => r['阶段'] === stage)
            if (kw) rows = rows.filter((r) => `${r['商机编号']} ${r['商机名称']} ${r['客户名称']}`.toLowerCase().includes(kw))
            rows.sort((a, b) => String(b['更新时间'] || '').localeCompare(String(a['更新时间'] || '')))
            return json(res, 200, { ok: true, items: rows.map((r) => ({
              id: r._id, no: r['商机编号'], name: r['商机名称'], customerName: r['客户名称'] || '',
              stage: r['阶段'] || '', amount: Number(r['商机金额万元']) || 0, expected: String(r['预计落单时间'] || '').slice(0, 10),
              owner: r['售前姓名'] || '', updated: String(r['更新时间'] || '').slice(0, 10), winRate: r['赢单率'] == null ? null : Number(r['赢单率']),
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
              versions: versions.filter((v) => (v['报价单'] || []).includes(q._id)).map((v) => ({ version: v['版本标识'], status: v['状态'], grossTotal: Number(v['含税合计']) || 0, change: v['变更说明'] || '' })),
            }))
            const docs = documents.filter((d) => d['商机编号'] === no).map((d) => ({ no: d['产物编号'], title: d['标题'], type: d['类型'], version: d['版本'], link: d['溯源'] || '', fileName: d['文件名'] || '' }))
            return json(res, 200, { ok: true, item: {
              id: r._id, no: r['商机编号'], name: r['商机名称'], customerNo: r['客户编号'] || '', customerName: r['客户名称'] || '',
              stage: r['阶段'] || '', amount: Number(r['商机金额万元']) || 0, expected: String(r['预计落单时间'] || '').slice(0, 10),
              source: r['来源'] || '', industryL1: r['行业门类（一级）'] || '', industryL2: r['行业大类（二级）'] || '',
              contact: r['联系人'] || '', phone: r['联系电话'] || '', intro: r['简介'] || '',
              seller: r['销售姓名'] || '', owner: r['售前姓名'] || '', winRate: r['赢单率'] == null ? null : Number(r['赢单率']),
              lastFollow: String(r['最后跟进时间'] || '').slice(0, 10),
            }, followups: followups.filter((f) => (f['商机'] || []).includes(r._id)).map((f) => ({
              no: f['跟进编号'], date: String(f['跟进日期'] || '').slice(0, 10), person: f['跟进人'] || '', way: f['方式'] || '',
              content: f['内容'] || '', next: f['下一步'] || '', nextDate: String(f['下次跟进'] || '').slice(0, 10),
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
            return json(res, 200, { ok: true, total, amount: rows.reduce((s, r) => s + (Number(r['商机金额万元']) || 0), 0), won, stages: agg('阶段'), industries: agg('行业门类（一级）'), sources: agg('来源'), top: rows.slice().sort((a, b) => (Number(b['商机金额万元']) || 0) - (Number(a['商机金额万元']) || 0)).slice(0, 5).map((r) => ({ no: r['商机编号'], name: r['商机名称'], amount: Number(r['商机金额万元']) || 0, stage: r['阶段'] })) })
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
              id: r._id, code: r['客户编号'] || '', name: r['客户名称'] || '', industry: r['行业'] || '', level: r['客户等级'] || '',
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
          if (route === 'products') {
            const kw = String(url.searchParams.get('keyword') || '').toLowerCase()
            const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50)
            const catalog = await loadCatalog()
            let rows = catalog.filter((p) => isQuotable(p))
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
          if (route === 'save' && req.method === 'POST') {
            const body = await readBody(req)
            const catalog = await loadCatalog()
            const lines = []
            const violations = []
            for (const [idx, it] of (body.items || []).entries()) {
              const found = findProduct(catalog, it.code || it.name)
              if (found.error) { violations.push({ level: 'block', message: `${it.code || it.name}：${found.error}` }); continue }
              if (found.candidates) { violations.push({ level: 'block', message: `「${it.code || it.name}」匹配到多个产品` }); continue }
              const p = found.product
              const qty = Number(it.qty) || 0
              const discount = Number(it.discount) || 1
              const expanded = expandProduct(p, { qty, discount, modules: it.modules, section: '一、产品报价' })
              for (const e of expanded) {
                for (const v of validateLine({ product: { ...p, name: e.name, stdPrice: e.stdPrice, costPrice: e.costPrice }, qty, discount, today: today() })) {
                  if (v.level === 'block') violations.push({ product: p.code, ...v })
                }
                const money = computeLine({ stdPrice: e.stdPrice, costPrice: e.costPrice, discount, qty, taxRate: e.taxRate })
                lines.push({ lineNo: lines.length + 1, code: e.code, name: e.name, spec: e.spec, brand: e.brand, model: e.model, unit: e.unit, qty, discount, stdPrice: e.stdPrice, ...money, section: e.section, remark: e.remark, category: e.category })
              }
            }
            if (violations.length) return json(res, 400, { ok: false, error: violations.map((v) => v.message).join('；') })
            const dto = buildQuoteDto({ lines, meta: { customerName: body.customerName || '', customerNo: body.customerNo || '', opportunityNo: body.opportunityNo || '' } })
            const out = await persistQuote(dto, { template: body.template })
            let rendered = null
            try {
              rendered = await renderQuoteXlsx(dto, { quoteNo: out.quoteNo, version: 'V1', date: today(), customerName: dto.customerName, validUntil: '' })
              if (rendered?.link && out.quoteId) await updateRecord('quotes', out.quoteId, { '文件链接': rendered.link })
              await registerDocument({ quoteNo: out.quoteNo, version: 'V1', customerName: dto.customerName, opportunityNo: dto.opportunityNo, opportunityName: dto.opportunityName, fileName: rendered?.name, link: rendered?.link })
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
