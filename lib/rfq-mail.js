/**
 * 询价邮件适配（纯函数，无 IO、不读配置、不发信）。
 *
 * 职责只有两件：
 *   1) 把询价单 + 商机 + 联系人拍成一封中文询价邮件（主题/纯文本/HTML）；
 *   2) 解析并校验收件人（支持显示名、逗号/分号/顿号/换行分隔、去重）。
 *
 * 发信一律交给 dsh-email（email_draft / email_send），本模块不持有账号、
 * 不知道 SMTP，也不会自己发信——发件账号与收件人由人确认。
 *
 * 字段口径对齐《售前数字员工/13-报价流程V2.md》sheet 6「询价单」：
 *   rfq = { 询价编号, 商机编号, 产品名称/规格/品牌/型号/单位/数量, 目标价（含税）,
 *           厂商名称/厂商邮箱, 回复截止, 备注 }
 */

/** 分隔符：英文/中文逗号、分号、顿号、换行。 */
const SPLIT_RE = /[,;，；、\r\n]+/
/** 邮箱收紧校验：不允许空白、尖括号、引号、分隔符。 */
const EMAIL_RE = /^[^\s@<>"'`,;()[\]]+@[^\s@<>"'`,;()[\]]+\.[^\s@<>"'`,;()[\]]{2,}$/

/** 取第一个有值的字段（兼容不同表头/驼峰写法）。 */
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return ''
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return ''
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim()
}

/** 金额：千分位，整数不带小数，否则保留 2 位；空值返回空串（Number('')===0 会误出 ¥0）。 */
export function formatMoney(n) {
  const raw = n === null || n === undefined ? '' : String(n).trim()
  if (!raw) return ''
  const num = Number(raw)
  if (!Number.isFinite(num)) return ''
  const [int, dec] = num.toFixed(2).split('.')
  const sep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return dec === '00' ? sep : `${sep}.${dec}`
}

/** 日期统一成 YYYY-MM-DD；认不出来的原样返回。 */
export function formatDate(v) {
  const s = str(v)
  if (!s) return ''
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  // 按本地时区取日期部分：'2026/11/10' 在 UTC+8 用 toISOString 会退成 11-09。
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) {
    const p2 = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }
  return s
}

/** 拆 "张三 <a@b.com>" / "\"张 三\" <a@b.com>" / "a@b.com"。 */
function splitAddress(token) {
  const angle = token.match(/^(.*?)<([^<>]*)>\s*$/)
  if (angle) {
    const name = str(angle[1]).replace(/^["']|["']$/g, '').trim()
    return { name: name || null, email: str(angle[2]), hasAngle: true }
  }
  if (token.includes('<') || token.includes('>')) return { name: null, email: '', hasAngle: true }
  return { name: null, email: token, hasAngle: false }
}

/**
 * 解析收件人。
 * @param {string|string[]} input 逗号/分号/顿号/换行分隔，或字符串数组
 * @returns {{valid: Array<{name: string|null, email: string}>, invalid: Array<{raw: string, reason: string}>}}
 *   reason: bad-format（尖括号不配）/ missing-email / bad-email / duplicate
 */
export function parseRecipients(input) {
  const valid = []
  const invalid = []
  const seen = new Set()

  const tokens = []
  const push = (v) => {
    for (const part of str(v).split(SPLIT_RE)) {
      if (str(part)) tokens.push(str(part))
    }
  }
  if (Array.isArray(input)) input.forEach(push)
  else push(input)

  for (const raw of tokens) {
    const { name, email, hasAngle } = splitAddress(raw)
    if (hasAngle && !email) {
      invalid.push({ raw, reason: 'bad-format' })
      continue
    }
    if (!email) {
      invalid.push({ raw, reason: 'missing-email' })
      continue
    }
    if (!EMAIL_RE.test(email)) {
      invalid.push({ raw, reason: 'bad-email' })
      continue
    }
    const key = email.toLowerCase()
    if (seen.has(key)) {
      invalid.push({ raw, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    valid.push({ name, email })
  }
  return { valid, invalid }
}

/** 把 parseRecipients().valid 拼成 RFC 5322 风格的 to 字符串。 */
export function formatRecipients(valid) {
  if (!Array.isArray(valid)) return ''
  return valid
    .filter((r) => r && r.email)
    .map((r) => (r.name ? `${r.name} <${r.email}>` : r.email))
    .join(', ')
}

function escapeHtml(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 询价明细行：单行字段优先，兼容 rfq.items 多行。 */
function normalizeItems(rfq) {
  const fromItems = Array.isArray(rfq && rfq.items) && rfq.items.length > 0
  const rows = fromItems ? rfq.items : [rfq || {}]
  return rows
    .map((it, i) => ({
      seq: i + 1,
      name: str(pick(it, 'productName', 'name', '产品名称')),
      spec: str(pick(it, 'spec', '规格')),
      brand: str(pick(it, 'brand', '品牌')),
      model: str(pick(it, 'model', '型号')),
      unit: str(pick(it, 'unit', '单位')),
      qty: str(pick(it, 'qty', 'quantity', '数量')),
      targetPrice: pick(it, 'targetPrice', 'targetPriceTax', '目标价'),
      // 单行形态下 rfq.note 是全单备注，统一放到结尾，避免同一句出现两次。
      note: fromItems ? str(pick(it, 'note', '备注')) : '',
    }))
    .filter((it) => it.name || it.spec || it.model || it.brand)
}

function itemTitle(it) {
  return it.name || it.model || it.spec || `第 ${it.seq} 项`
}

/** 一行明细的纯文本形态。 */
function itemLine(it) {
  const parts = [itemTitle(it)]
  if (it.spec) parts.push(`规格：${it.spec}`)
  if (it.brand) parts.push(`品牌：${it.brand}`)
  if (it.model) parts.push(`型号：${it.model}`)
  if (it.unit) parts.push(`单位：${it.unit}`)
  if (it.qty) parts.push(`数量：${it.qty}`)
  const price = formatMoney(it.targetPrice)
  if (price) parts.push(`目标价（含税）：¥${price}`)
  if (it.note) parts.push(`备注：${it.note}`)
  return parts.join('｜')
}

/** 明细的 HTML 形态（逐段转义）。 */
function itemHtml(it) {
  const parts = [`<strong>${escapeHtml(itemTitle(it))}</strong>`]
  if (it.spec) parts.push(`规格：${escapeHtml(it.spec)}`)
  if (it.brand) parts.push(`品牌：${escapeHtml(it.brand)}`)
  if (it.model) parts.push(`型号：${escapeHtml(it.model)}`)
  if (it.unit) parts.push(`单位：${escapeHtml(it.unit)}`)
  if (it.qty) parts.push(`数量：${escapeHtml(it.qty)}`)
  const price = formatMoney(it.targetPrice)
  if (price) parts.push(`目标价（含税）：¥${escapeHtml(price)}`)
  if (it.note) parts.push(`备注：${escapeHtml(it.note)}`)
  return parts.join('｜')
}

function opportunityLine(opportunity) {
  const o = opportunity || {}
  const no = str(pick(o, 'no', 'oppNo', '商机编号'))
  const name = str(pick(o, 'name', 'oppName', '商机名称'))
  const customer = str(pick(o, 'customerName', 'customer', '客户'))
  const stage = str(pick(o, 'stage', '阶段'))
  const expected = formatDate(pick(o, 'expected', 'expectedDate', '预计落单时间'))
  const attrs = []
  if (customer) attrs.push(`客户：${customer}`)
  if (stage) attrs.push(`阶段：${stage}`)
  if (expected) attrs.push(`预计落单：${expected}`)
  const head = [no, name].filter(Boolean).join(' · ')
  if (!head && !attrs.length) return null
  return attrs.length ? `${head || '（商机待补）'}（${attrs.join('；')}）` : (head || '（商机待补）')
}

function contactLine(sender) {
  const s = sender || {}
  const parts = [
    str(pick(s, 'name', '姓名')),
    str(pick(s, 'title', '职务')),
    str(pick(s, 'phone', 'mobile', '手机')),
    str(pick(s, 'email', '邮件')),
  ].filter(Boolean)
  const company = str(pick(s, 'company', '公司'))
  if (!parts.length && !company) return null
  const line = parts.join('｜')
  return company ? `${line || '（联系人待补）'}｜${company}` : (line || '（联系人待补）')
}

/** 结构化中间模型：text 与 html 都从这里渲染，避免两套文案漂移。 */
function buildModel({ rfq, opportunity, sender }) {
  const r = rfq || {}
  const items = normalizeItems(r)
  const rfqNo = str(pick(r, 'no', 'rfqNo', '询价编号'))
  const replyBy = formatDate(pick(r, 'replyBy', 'replyDeadline', 'dueDate', 'deadline', '回复截止'))
  const targetPrice = formatMoney(pick(r, 'targetPrice', 'targetPriceTax', '目标价（含税）', '目标价'))
  const taxRate = str(pick(r, 'taxRate', '税率'))
  const validityDays = str(pick(r, 'validityDays', '报价有效期')) || '30'
  const vendor = str(pick(r, 'vendor', 'vendorName', '厂商名称'))
  const remark = str(pick(r, 'note', '备注'))

  const meta = []
  const oppLine = opportunityLine(opportunity)
  if (oppLine) meta.push({ label: '商机', value: oppLine })
  if (rfqNo) meta.push({ label: '询价单号', value: rfqNo })
  if (vendor) meta.push({ label: '询价对象', value: vendor })
  if (items.length > 1) meta.push({ label: '产品概要', value: `${itemTitle(items[0])} 等 ${items.length} 项` })

  const requirements = []
  requirements.push(
    targetPrice
      ? `目标价（含税）：¥${targetPrice}；高于目标价请说明理由`
      : '目标价：暂无，请给最优价',
  )
  requirements.push(
    `请注明含税单价与税率${taxRate ? `（${taxRate}）` : '（13%）'}，运费、实施与调试费是否包含在内`
  )
  requirements.push(`报价有效期不少于 ${validityDays} 天，交货期请一并写明`)
  requirements.push('请随附盖章报价单（PDF）与产品彩页')

  const sections = [{ title: '一、询价清单', kind: 'ol', items: items.map(itemLine), itemsHtml: items.map(itemHtml) }]
  sections.push({ title: '二、报价要求', kind: 'ul', items: requirements, itemsHtml: requirements.map(escapeHtml) })
  sections.push({
    title: '三、回复截止',
    kind: 'ul',
    items: [
      replyBy
        ? `${replyBy} 前回复本邮件（如无法按时，请提前告知）`
        : '请于 3 个工作日内回复本邮件（如无法按时，请提前告知）',
    ],
  })
  sections[sections.length - 1].itemsHtml = sections[sections.length - 1].items.map(escapeHtml)

  const contact = contactLine(sender)
  if (contact) sections.push({ title: '四、联系人', kind: 'ul', items: [contact], itemsHtml: [escapeHtml(contact)] })

  const closing = remark
    ? [`备注：${remark}`, '如清单有歧义请直接回复确认，谢谢！']
    : ['如清单有歧义请直接回复确认，谢谢！']

  return { meta, sections, closing, items, rfqNo }
}

function subjectOf({ rfq, opportunity, items, rfqNo }) {
  const r = rfq || {}
  const customer = str(pick(opportunity || {}, 'customerName', 'customer', '客户'))
  const first = items.length ? itemTitle(items[0]) : ''
  const summary = items.length > 1 ? `${first} 等 ${items.length} 项` : first
  const subjectNo = str(pick(r, 'subjectNo', '询价编号')) || rfqNo
  const body = [customer, summary].filter(Boolean).join(' ') || '产品询价'
  return `【询价】${body}${subjectNo ? `（${subjectNo}）` : ''}`
}

function renderText(model) {
  const { meta, sections, closing } = model
  const out = ['您好：', '']
  out.push('现就以下产品向贵司询价，烦请报价。', '')
  for (const m of meta) out.push(`【${m.label}】${m.value}`)
  if (meta.length) out.push('')
  for (const sec of sections) {
    out.push(sec.title)
    if (sec.kind === 'ol') {
      sec.items.forEach((line, i) => out.push(`${i + 1}. ${line}`))
    } else {
      sec.items.forEach((line) => out.push(`- ${line}`))
    }
    out.push('')
  }
  for (const line of closing) out.push(line)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderHtml(model) {
  const { meta, sections, closing } = model
  const p = (t) => `<p style="margin:0 0 10px">${t}</p>`
  const parts = ['<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;font-size:14px;line-height:1.7;color:#222">']
  parts.push(p('您好：'))
  parts.push(p('现就以下产品向贵司询价，烦请报价。'))
  if (meta.length) {
    parts.push(
      `<p style="margin:0 0 10px">${meta
        .map((m) => `${escapeHtml(m.label)}：${escapeHtml(m.value)}`)
        .join('<br>')}</p>`,
    )
  }
  for (const sec of sections) {
    parts.push(`<p style="margin:16px 0 8px"><strong>${escapeHtml(sec.title)}</strong></p>`)
    const tag = sec.kind === 'ol' ? 'ol' : 'ul'
    const lis = sec.itemsHtml.map((h) => `<li style="margin:0 0 6px">${h}</li>`).join('')
    parts.push(`<${tag} style="margin:0 0 10px;padding-left:22px">${lis}</${tag}>`)
  }
  for (const line of closing) parts.push(p(escapeHtml(line)))
  parts.push('</div>')
  return parts.join('\n')
}

/**
 * 生成询价邮件内容。
 *
 * recipients 可选：只做自检（不写进正文——正文不该出现邮箱）。给了却一个都解析不出来时
 * 直接抛错，避免把一封注定发不出去的信交给人工核对。分项提示用 parseRecipients()。
 *
 * @param {{rfq?: object, opportunity?: object, sender?: object, recipients?: string|string[]}} params
 * @returns {{subject: string, text: string, html: string}}
 */
export function buildRfqMail({ rfq, opportunity, sender, recipients } = {}) {
  const hasRecipients = Array.isArray(recipients)
    ? recipients.some((v) => str(v))
    : Boolean(str(recipients))
  if (hasRecipients) {
    const { valid, invalid } = parseRecipients(recipients)
    if (!valid.length) {
      const detail = invalid.map((x) => `${x.raw}（${x.reason}）`).join('、') || '空'
      throw new Error(`收件人无法解析：${detail}`)
    }
  }
  const model = buildModel({ rfq, opportunity, sender })
  return {
    subject: subjectOf({ rfq, opportunity, items: model.items, rfqNo: model.rfqNo }),
    text: renderText(model),
    html: renderHtml(model),
  }
}
