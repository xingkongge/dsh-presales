/**
 * 售前数字员工 · 报价工作台（Web 面板）
 * 侧栏图标 + 中央面板；数据走 Host 同源接口 /presales/api/*。
 */
window.__ModuleLoader__.load({
  id: '@cnbm/dsh-presales',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'presales'
    let uiWorkspace = null
    let uiLayout = null
    let clientCtx = null
    const FALLBACK_OPP_PROMPT = `你是数字售前助手。请先调用 opp_board 确认后台数据连接正常，然后用一两句话回复用户：
「后台数据连接正常。请用自然语言描述你要新建的商机（客户、项目/商机名称、金额、阶段、预计落单时间、联系人等），我来帮你建档。」
不要列举、比对或引用知识库里已有的商机数据，也不要输出示例清单。
用户回复后，调用 opp_create 新建商机；缺关键字段时简短追问，成功后只回复商机编号和已写入的字段摘要。`
    const API = '/presales/api/'
    const HDR = { 'x-dsh-presales': '1' }

    const FALLBACK_CUSTOMER_PROMPT = `帮我新建一个客户。`

    const STYLE_MARK = 'dsh-presales/panel.css'
    const STYLE = `
.presales-panel{box-sizing:border-box;height:100%;overflow:auto;padding:20px 24px 56px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:14px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.presales-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.presales-title{font-size:18px;font-weight:650}
.presales-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px}
.presales-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.presales-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.presales-grid{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:10px}
.presales-label{color:var(--dsw-alias-label-secondary);font-size:12px;display:block;margin-bottom:4px}
.presales-input,.presales-select{box-sizing:border-box;width:100%;padding:7px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.presales-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 28%, transparent));background:var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 7%, transparent));color:var(--dsw-alias-label-primary, inherit);cursor:pointer;font-size:13px;text-decoration:none;line-height:1.2}
.presales-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.presales-btn.primary{background:#2563eb !important;color:#ffffff !important;border:1px solid #1d4ed8 !important;font-weight:600}
.presales-btn.primary:hover{background:#1d4ed8 !important}
.presales-btn.primary[disabled]{background:#3b82f6 !important;color:#ffffff !important;opacity:.6}
.presales-btn[disabled]{opacity:.5;cursor:default}
.presales-table{width:100%;border-collapse:collapse;font-size:13px}
.presales-table th{ text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.presales-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.presales-table input{width:72px;padding:4px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font-size:13px}
.presales-results{list-style:none;margin:8px 0 0;padding:0;max-height:220px;overflow:auto}
.presales-results li{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer}
.presales-results li:hover{background:var(--dsw-alias-bg-layer-2)}
.presales-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.presales-total{display:flex;gap:24px;flex-wrap:wrap;font-size:13px}
.presales-total b{font-size:16px}
.presales-msg{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:13px}
.presales-msg.ok{color:var(--dsw-alias-state-success-primary);border:1px solid currentColor}
.presales-msg.err{color:var(--dsw-alias-state-error-primary);border:1px solid currentColor}
.presales-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor}
button.presales-badge{background:transparent;cursor:pointer}
.presales-badge.ok{color:var(--dsw-alias-state-success-primary)}
.presales-badge.err{color:var(--dsw-alias-state-error-primary)}
.presales-badge.warn{color:var(--dsw-alias-state-warn-primary)}
.presales-quotes{list-style:none;margin:0;padding:0}
.presales-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#e5484d;margin-left:4px;vertical-align:middle}
.presales-tree{display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:260px;overflow:auto}
.presales-tree-l1{display:flex;align-items:center;gap:6px;background:none;border:0;color:var(--dsw-alias-label-primary);cursor:pointer;padding:4px 2px;font-size:13px;text-align:left}
.presales-tree-l1.active{color:var(--dsw-alias-brand-primary);font-weight:600}
.presales-tree-l2{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px 18px}
.presales-tree-l2 button{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.presales-tree-l2 button.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.presales-tabs{display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}
.presales-tab{padding:6px 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px}
.presales-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.presales-kv{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:6px 16px;font-size:13px}
.presales-kv b{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400}
.presales-list{list-style:none;margin:0;padding:0}
.presales-list li{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:13px}
.presales-quotes li{padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:13px;display:flex;justify-content:space-between;gap:10px}
`
    const money = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const round = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) + Number.EPSILON) * f) / f }

    async function api(route, init) {
      const res = await fetch(API + route, {
        ...init,
        headers: { ...HDR, 'content-type': 'application/json', ...(init && init.headers) },
      })
      const text = await res.text()
      let data
      try { data = text ? JSON.parse(text) : {} } catch { data = { error: text } }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    function computeTotals(cart) {
      let untaxed = 0; let tax = 0; let cost = 0
      for (const l of cart) {
        const unit = round(l.stdPrice * l.discount, 4)
        const sub = round(unit * l.qty, 2)
        untaxed += sub
        tax += round(sub * l.taxRate, 2)
        cost += round((l.costPrice || 0) * l.qty, 2)
      }
      untaxed = round(untaxed); tax = round(tax)
      const gross = round(untaxed + tax)
      const profit = round(untaxed - cost)
      return { untaxed, tax, gross, profit, margin: untaxed > 0 ? profit / untaxed : null }
    }

    function OppTab({ onQuote, onReload, onNewOpp }) {
      const [items, setItems] = React.useState([])
      const [board, setBoard] = React.useState(null)
      const [keyword, setKeyword] = React.useState('')
      const [stage, setStage] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const STAGES = ['线索阶段', '初步沟通', '需求沟通', '方案报价', '商务谈判', '招标阶段', '暂停阶段', '放弃', '赢单', '丢单', '作废']
      const [nextStage, setNextStage] = React.useState('')
      const [reason, setReason] = React.useState('')
      const [form, setForm] = React.useState({ way: '电话', person: '', content: '', next: '', date: '', nextDate: '' })
      const [customers, setCustomers] = React.useState([])
      const [oppForm, setOppForm] = React.useState(null)

      async function loadRfqs() {
        try { const r = await api('rfq_list'); setRfqs(r.items || []) } catch {}
      }

      async function openRfq(no) {
        try { const d = await api('rfq_detail?id=' + encodeURIComponent(no)); setRfqView(d); setRfqEmail(d.header['厂商邮箱'] || ''); const p = {}; (d.items || []).forEach((it) => { p[it.id] = it['回复报价（含税）'] ?? '' }); setRfqPrices(p) }
        catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function load() {
        try {
          const [ls, bd, cs] = await Promise.all([api('opps?keyword=' + encodeURIComponent(keyword) + '&stage=' + encodeURIComponent(stage)), api('opp_board'), api('customers')])
          setItems(ls.items || []); setBoard(bd); setCustomers(cs.items || [])
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }
      React.useEffect(() => { void load() }, [])

      async function open(no) {
        setBusy(true); setMsg(null)
        try {
          const r = await api('opp?no=' + encodeURIComponent(no))
          setDetail(r); setNextStage(r.item.stage); setReason('')
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }
      async function changeStage() {
        if (!detail) return
        setBusy(true)
        try {
          await api('opp_stage', { method: 'POST', body: JSON.stringify({ no: detail.item.no, stage: nextStage, reason }) })
          await open(detail.item.no); await load()
          setMsg({ kind: 'ok', text: `阶段已更新为 ${nextStage}` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }
      async function addFollowup(form) {
        if (!detail || !form.content) { setMsg({ kind: 'err', text: '请填写跟进内容' }); return }
        setBusy(true)
        try {
          await api('opp_followup', { method: 'POST', body: JSON.stringify({ no: detail.item.no, content: form.content, way: form.way, person: form.person, date: form.date, next: form.next, nextDate: form.nextDate }) })
          await open(detail.item.no)
          setMsg({ kind: 'ok', text: '跟进已登记' })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function saveOpp() {
        if (!oppForm || !String(oppForm.name || '').trim()) { setMsg({ kind: 'err', text: '商机名称必填' }); return }
        try {
          const r = await api('opp_save', { method: 'POST', body: JSON.stringify(oppForm) })
          setOppForm(null)
          await load()
          setMsg({ kind: 'ok', text: `已新建商机 ${r.no}` })
          await open(r.no)
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      function oppField(key, label, type = 'text') {
        return h('label', null, h('span', { className: 'presales-label' }, label),
          h('input', { className: 'presales-input', type, value: oppForm?.[key] ?? '', onChange: (e) => setOppForm({ ...oppForm, [key]: e.target.value }) }))
      }

      if (oppForm) {
        return h('div', null,
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
              h('b', null, '新建商机'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => setOppForm(null) }, '取消')),
            h('div', { className: 'presales-grid', style: { marginTop: 8 } },
              oppField('name', '商机名称'),
              h('label', null, h('span', { className: 'presales-label' }, '客户'),
                h('select', { className: 'presales-select', value: oppForm.customerId || '', onChange: (e) => {
                  const c = customers.find((x) => x.id === e.target.value)
                  setOppForm({ ...oppForm, customerId: e.target.value, customerNo: c?.code || '', customerName: c?.name || '' })
                } },
                h('option', { value: '' }, '请选择客户'),
                customers.map((c) => h('option', { key: c.id, value: c.id }, `${c.name}${c.code ? ' · ' + c.code : ''}`)))),
              oppField('amount', '金额（万元）', 'number'),
              h('label', null, h('span', { className: 'presales-label' }, '阶段'),
                h('select', { className: 'presales-select', value: oppForm.stage || '线索阶段', onChange: (e) => setOppForm({ ...oppForm, stage: e.target.value }) },
                  STAGES.map((x) => h('option', { key: x, value: x }, x)))),
              oppField('expected', '预计落单', 'date'),
              h('label', null, h('span', { className: 'presales-label' }, '来源'),
                h('select', { className: 'presales-select', value: oppForm.source || '主动开发', onChange: (e) => setOppForm({ ...oppForm, source: e.target.value }) },
                  ['主动开发','客户介绍','渠道合作','招标','老客户复购','其他'].map((x) => h('option', { key: x, value: x }, x)))),
              oppField('industryL1', '行业门类（一级）'), oppField('industryL2', '行业大类（二级）'),
              oppField('contact', '联系人'), oppField('phone', '联系电话'),
              oppField('sellerName', '销售'), oppField('ownerName', '售前')),
            h('label', null, h('span', { className: 'presales-label' }, '简介'),
              h('textarea', { className: 'presales-input', style: { minHeight: 70 }, value: oppForm.intro || '', onChange: (e) => setOppForm({ ...oppForm, intro: e.target.value }) })),
            h('div', { className: 'presales-row', style: { marginTop: 8 } },
              h('button', { className: 'presales-btn primary', type: 'button', onClick: () => void saveOpp() }, '保存'))))
      }

      if (detail) {
        const it = detail.item
        const set = (k, v) => setForm({ ...form, [k]: v })
        return h('div', null,
          h('div', { className: 'presales-row', style: { marginBottom: 10 } },
            h('button', { className: 'presales-btn', type: 'button', onClick: () => setDetail(null) }, '← 返回列表'),
            h('b', null, `${it.no} ${it.name}`)),
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-kv' },
              h('div', null, h('b', null, '客户'), it.customerName || '-'),
              h('div', null, h('b', null, '阶段'), it.stage),
              h('div', null, h('b', null, '金额'), `${it.amount} 万`),
              h('div', null, h('b', null, '行业'), `${it.industryL1 || '-'} / ${it.industryL2 || '-'}`),
              h('div', null, h('b', null, '销售 / 售前'), `${it.seller || '-'} / ${it.owner || '-'}`),
              h('div', null, h('b', null, '预计落单'), it.expected || '-'),
              h('div', null, h('b', null, '联系人'), `${it.contact || '-'} ${it.phone || ''}`),
              h('div', null, h('b', null, '来源'), it.source || '-'),
              h('div', null, h('b', null, '最后跟进'), it.lastFollow || '-')),
            it.intro ? h('div', { className: 'presales-muted', style: { marginTop: 8 } }, it.intro) : null,
            h('div', { className: 'presales-row', style: { marginTop: 12 } },
              h('select', { className: 'presales-select', style: { maxWidth: 160 }, value: nextStage, onChange: (e) => setNextStage(e.target.value) }, STAGES.map((s) => h('option', { key: s, value: s }, s))),
              h('input', { className: 'presales-input', style: { maxWidth: 260 }, placeholder: '变更原因（可选）', value: reason, onChange: (e) => setReason(e.target.value) }),
              h('button', { className: 'presales-btn primary', type: 'button', disabled: busy, onClick: () => void changeStage() }, '推进阶段'))),
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-muted' }, '登记跟进'),
            h('div', { className: 'presales-row', style: { marginTop: 8 } },
              h('select', { className: 'presales-select', style: { maxWidth: 110 }, value: form.way, onChange: (e) => set('way', e.target.value) }, ['电话', '拜访', '会议', '邮件', '微信', '其他'].map((w) => h('option', { key: w, value: w }, w))),
              h('input', { className: 'presales-input', style: { maxWidth: 120 }, placeholder: '跟进人', value: form.person, onChange: (e) => set('person', e.target.value) }),
              h('input', { className: 'presales-input', style: { maxWidth: 150 }, type: 'date', value: form.date, onChange: (e) => set('date', e.target.value) })),
            h('textarea', { className: 'presales-input', style: { marginTop: 8, minHeight: 60 }, placeholder: '跟进内容', value: form.content, onChange: (e) => set('content', e.target.value) }),
            h('div', { className: 'presales-row', style: { marginTop: 8 } },
              h('input', { className: 'presales-input', style: { maxWidth: 300 }, placeholder: '下一步', value: form.next, onChange: (e) => set('next', e.target.value) }),
              h('input', { className: 'presales-input', style: { maxWidth: 150 }, type: 'date', value: form.nextDate, onChange: (e) => set('nextDate', e.target.value) }),
              h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void addFollowup(form) }, '保存跟进'))),

        msg ? h('div', { className: `presales-msg ${msg.kind === 'ok' ? 'ok' : 'err'}` }, msg.text) : null,
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-muted', style: { marginBottom: 6 } }, `报价（${detail.quotes.length}）`),
            detail.quotes.length ? h('ul', { className: 'presales-quotes' }, detail.quotes.map((q) => h('li', { key: q.quoteNo },
              h('span', null, h('b', null, q.quoteNo), ` ${q.version} · ${q.status}`),
              h('span', null, q.link ? h('a', { href: q.link, target: '_blank', rel: 'noreferrer', style: { marginRight: 10 } }, '打开') : null, `含税 ${money(q.grossTotal)}`)))) : h('div', { className: 'presales-muted' }, '暂无报价')),
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-muted', style: { marginBottom: 6 } }, `跟进记录（${detail.followups.length}）`),
            detail.followups.length ? h('ul', { className: 'presales-list' }, detail.followups.map((f) => h('li', { key: f.no },
              `${f.date} ${f.way} ${f.person}：${f.content}`, f.next ? h('div', { className: 'presales-muted' }, `下一步：${f.next} ${f.nextDate || ''}`) : null))) : h('div', { className: 'presales-muted' }, '暂无')),
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-muted', style: { marginBottom: 6 } }, `变更记录（${detail.changes.length}）`),
            detail.changes.length ? h('ul', { className: 'presales-list' }, detail.changes.map((c, i) => h('li', { key: i },
              `${c.date} ${c.field}：${c.old} → ${c.val}`, c.reason ? h('span', { className: 'presales-muted' }, `（${c.reason}）`) : null))) : h('div', { className: 'presales-muted' }, '暂无')),
          h('section', { className: 'presales-card' },
            h('div', { className: 'presales-muted', style: { marginBottom: 6 } }, `相关产物（${detail.documents.length}）`),
            detail.documents.length ? h('ul', { className: 'presales-list' }, detail.documents.map((d) => h('li', { key: d.no },
              `${d.no} · ${d.title} · ${d.type} ${d.version}`, d.link ? h('a', { href: d.link, target: '_blank', rel: 'noreferrer', style: { marginLeft: 8 } }, '打开') : null))) : h('div', { className: 'presales-muted' }, '暂无')))
      }

      return h('div', null,
        h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'presales-row' },
              h('input', { className: 'presales-input', style: { maxWidth: 260 }, placeholder: '搜商机名称/客户/编号', value: keyword, onChange: (e) => setKeyword(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void load() } }),
              h('select', { className: 'presales-select', style: { maxWidth: 130 }, value: stage, onChange: (e) => { setStage(e.target.value); setTimeout(() => void load(), 0) } },
                h('option', { value: '' }, '全部阶段'), STAGES.map((s) => h('option', { key: s, value: s }, s))),
              h('span', { className: 'presales-muted' }, `共 ${items.length} 个商机`)),
            h('div', { className: 'presales-row' },
              h('button', { className: 'presales-btn', type: 'button', onClick: () => setOppForm({ stage: '线索阶段', source: '主动开发', amount: '', expected: '' }) }, '新建商机'),
              h('button', { className: 'presales-btn primary', type: 'button', onClick: () => onNewOpp && onNewOpp() }, '新建商机（对话）'))),
          board ? h('div', { className: 'presales-muted', style: { marginTop: 6 } },
            `总金额 ${board.amount.toFixed(0)} 万 · 赢单 ${board.won} · 赢单率 ${board.total ? ((board.won / board.total) * 100).toFixed(0) + '%' : '-'}`) : null,
          h('table', { className: 'presales-table', style: { marginTop: 8 } },
            h('thead', null, h('tr', null, ['商机名称', '编号', '客户', '阶段', '金额(万)', '预计落单'].map((t) => h('th', { key: t }, t)))),
            h('tbody', null, items.map((o) => h('tr', { key: o.id, style: { cursor: 'pointer' }, onClick: () => void open(o.no) },
              h('td', null, h('b', null, o.name)), h('td', null, o.no), h('td', null, o.customerName || '-'),
              h('td', null, o.stage || '-'), h('td', null, o.amount ?? 0), h('td', null, o.expected || '-')))))),
        msg ? h('div', { className: `presales-msg ${msg.kind === 'ok' ? 'ok' : 'err'}` }, msg.text) : null)
    }

    function Panel() {
      const [tab, setTab] = React.useState('customer')
      const [status, setStatus] = React.useState(null)
      const [customers, setCustomers] = React.useState([])
      const [opps, setOpps] = React.useState([])
      const [templates, setTemplates] = React.useState([])
      const [quotes, setQuotes] = React.useState([])
      const [customerId, setCustomerId] = React.useState('')
      const [oppId, setOppId] = React.useState('')
      const [template, setTemplate] = React.useState('')
      const [keyword, setKeyword] = React.useState('')
      const [results, setResults] = React.useState([])
      const [cats, setCats] = React.useState([])
      const [cat, setCat] = React.useState({ l1: '', l2: '' })
      const [expanded, setExpanded] = React.useState({})
      const [cart, setCart] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [lastQuote, setLastQuote] = React.useState(null)
      const [updates, setUpdates] = React.useState(null)
      const [updatesOpen, setUpdatesOpen] = React.useState(false)
      const [localTpl, setLocalTpl] = React.useState(null)
      const [tplNotice, setTplNotice] = React.useState(null)
      const [sections, setSections] = React.useState([])
      const [section, setSection] = React.useState('')
      const [tempOpen, setTempOpen] = React.useState(false)
      const [tempForm, setTempForm] = React.useState({ name: '', spec: '', brand: '', model: '', unit: '项', qty: 1, price: '' })
      const [tempRfq, setTempRfq] = React.useState(true)
      const [mailPreview, setMailPreview] = React.useState(null)
      const [mailAccounts, setMailAccounts] = React.useState([])
      const [mailFrom, setMailFrom] = React.useState(() => localStorage.getItem('presales.lastRfqFrom') || '')
      const [mailTo, setMailTo] = React.useState('')
      const [draftMsg, setDraftMsg] = React.useState('')
      const [showCounts, setShowCounts] = React.useState(false)
      const [rfqs, setRfqs] = React.useState([])
      const [rfqView, setRfqView] = React.useState(null)
      const [rfqPrices, setRfqPrices] = React.useState({})
      const [rfqEmail, setRfqEmail] = React.useState('')
      const [custDetail, setCustDetail] = React.useState(null)
      const [custForm, setCustForm] = React.useState(null)
      const [custQuery, setCustQuery] = React.useState('')
      const [lookupBusy, setLookupBusy] = React.useState(false)
      const [lookupSources, setLookupSources] = React.useState([])
      const [selected, setSelected] = React.useState({})
      const [mailQueue, setMailQueue] = React.useState([])
      const fileRef = React.useRef(null)
      const [updating, setUpdating] = React.useState('')
      const [chatNotice, setChatNotice] = React.useState('')
      const [oppPrompt, setOppPrompt] = React.useState('')
      const [msg, setMsg] = React.useState(null)

      const customer = customers.find((c) => c.id === customerId) || null
      const opp = opps.find((o) => o.id === oppId) || null
      const totals = computeTotals(cart)

      async function loadRfqs() {
        try { const r = await api('rfq_list'); setRfqs(r.items || []) } catch {}
      }

      async function openRfq(no) {
        try { const d = await api('rfq_detail?id=' + encodeURIComponent(no)); setRfqView(d); setRfqEmail(d.header['厂商邮箱'] || ''); const p = {}; (d.items || []).forEach((it) => { p[it.id] = it['回复报价（含税）'] ?? '' }); setRfqPrices(p) }
        catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function load() {
        try {
          // 一次请求拿齐首页数据，避免多个 WPS 路由串行/重复拉表
          const b = await api('bootstrap')
          if (!b.ok) throw new Error(b.error || 'WPS 数据加载失败')
          setStatus(b.status)
          setCustomers(b.customers || [])
          setTemplates(b.templates || [])
          setQuotes(b.quotes || [])
          setCats(b.categories || [])
          const def = (b.templates || []).find((x) => x.default) || (b.templates || [])[0]
          if (def) setTemplate(def.name)
          api('skill_prompt').then((sp) => { if (sp?.prompt) setOppPrompt(sp.prompt) }).catch(() => {})
          // 模板文件检查很慢，放后台，不阻塞首屏
          api('template_check').then((tc) => setTplNotice(tc && (tc.added?.length || tc.updates?.length || tc.missing?.length) ? tc : null)).catch(() => {})
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }
      React.useEffect(() => { void load(); void checkUpdates() }, [])
      React.useEffect(() => { if (tab === 'rfq') void loadRfqs() }, [tab])
      React.useEffect(() => {
        api('email_accounts').then((r) => {
          let list = Array.isArray(r.accounts) ? r.accounts.map((a) => (typeof a === 'string' ? { name: a, email: '', label: a } : a)) : []
          if (!list.length) {
            list = (r.raw?.checks || []).map((c) => {
              const name = String(c.name || '').replace(/^账号\s*/, '').trim()
              const email = (String(c.detail || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0]
              return { name, email, label: email ? `${name} · ${email}` : name }
            }).filter((x) => x.name && x.name !== '邮箱配置')
          }
          setMailAccounts(list)
          const names = list.map((x) => x.name)
          if (names.length) {
            const last = localStorage.getItem('presales.lastRfqFrom') || ''
            setMailFrom((prev) => (prev && names.includes(prev) ? prev : (names.includes(last) ? last : names[0])))
          }
        }).catch(() => {})
      }, [])
      React.useEffect(() => {
        if (!template) return
        let alive = true
        api('template_sections?template=' + encodeURIComponent(template)).then((r) => {
          if (!alive) return
          const list = r.sections || []
          setSections(list)
          setSection((prev) => (list.some((x) => x.title === prev) ? prev : (list[0]?.title || '产品报价')))
        }).catch(() => {})
        return () => { alive = false }
      }, [template])

      async function loadOpps(cid) {
        setOpps([]); setOppId('')
        if (!cid) return
        try {
          const r = await api('opportunities?customerId=' + encodeURIComponent(cid))
          setOpps(r.items || [])
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function search(filter = cat) {
        if (busy) return
        setBusy(true); setMsg(null)
        try {
          const qs = new URLSearchParams({ limit: '20' })
          if (keyword) qs.set('keyword', keyword)
          if (filter && filter.l1) qs.set('l1', filter.l1)
          if (filter && filter.l2) qs.set('l2', filter.l2)
          const r = await api('products?' + qs.toString())
          setResults(r.items || [])
          if (!(r.items || []).length) setMsg({ kind: 'err', text: '该分类/关键字下没有在售产品' })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      function pickCat(l1, l2) {
        const next = { l1, l2 }
        setCat(next)
        void search(next)
      }

      const itemKey = (x) => x.uid || `${x.code}@@${x.section || ''}`
      async function addTemp() {
        if (!tempForm.name.trim()) { setMsg({ kind: 'err', text: '临时产品需要名称' }); return }
        const item = {
          code: `TMP-${Date.now()}`, name: tempForm.name.trim(), spec: tempForm.spec, brand: tempForm.brand,
          model: tempForm.model, unit: tempForm.unit || '项', stdPrice: Number(tempForm.price) || 0,
          taxRate: 0.13, qty: Number(tempForm.qty) || 1, discount: 1, temp: true, section: tempForm.section || section, category: tempForm.category || '', remark: tempForm.remark || '',
          uid: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }
        setCart((prev) => [...prev, item])
        if (tempRfq) setSelected((prev) => ({ ...prev, [item.uid]: true }))
        setTempForm({ name: '', spec: '', brand: '', model: '', unit: '项', qty: 1, price: '', expand: false })
        setTempOpen(false)
      }

      async function openRfqMail(line) {
        if (!line.rfqId) { setMsg({ kind: 'err', text: '这一行没有关联询价单' }); return }
        try { const m = await api('rfq_mail?id=' + encodeURIComponent(line.rfqId)); setMailPreview(m); setMailTo(m.to || ''); setDraftMsg('') }
        catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function syncRfqReplies() {
        setBusy(true); setMsg(null)
        try {
          const r = await api('rfq_sync', { method: 'POST', body: JSON.stringify({}) })
          const updated = r.updated || []
          if (updated.length) {
            setCart((prev) => prev.map((x) => {
              const hit = updated.find((u) => u.no && u.no === x.rfqNo)
              return hit ? { ...x, stdPrice: round(hit.price / 1.13, 2), remark: '已询价回填' } : x
            }))
          }
          setMsg({ kind: 'ok', text: `已检查 ${r.checked || 0} 条询价，回填 ${updated.length} 条` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      function toggleSelect(key) {
        setSelected((prev) => ({ ...prev, [key]: !prev[key] }))
      }

      async function ensureRfq(line) {
        if (line.rfqId) return line.rfqId
        const r = await api('rfq_create', { method: 'POST', body: JSON.stringify({
          opportunityNo: opp ? opp.no : '', opportunityName: opp ? opp.name : '',
          name: line.name, spec: line.spec, brand: line.brand, model: line.model, unit: line.unit,
          qty: line.qty, targetPrice: line.stdPrice, section: line.section || section,
        }) })
        setCart((prev) => prev.map((x) => itemKey(x) === itemKey(line) ? { ...x, rfqId: r.id, rfqNo: r.no } : x))
        return r.id
      }

      async function markMailSent() {
        const id = mailPreview?.id || rfqView?.header?.id
        if (!id) { setMsg({ kind: 'err', text: '没有可标记的询价单' }); return }
        try {
          await api('rfq_sent', { method: 'POST', body: JSON.stringify({ id, sender: mailFrom, sentAt: new Date().toISOString().slice(0, 10) }) })
          setDraftMsg('已标记为已发送')
          if (mailPreview) setMailPreview({ ...mailPreview, sent: true })
          await loadRfqs()
          if (rfqView) setRfqView(await api('rfq_detail?id=' + encodeURIComponent(rfqView.header['询价编号'])))
        } catch (e) { setDraftMsg(String(e.message || e)) }
      }

      async function batchMail() {
        setBusy(true); setMsg({ kind: 'ok', text: '正在生成询价单…' })
        const picked = cart.filter((x) => x.temp && selected[itemKey(x)])
        if (!picked.length) { setMsg({ kind: 'err', text: '请先勾选要询价的临时产品' }); setBusy(false); return }
        const groups = new Map()
        for (const l of picked) {
          const key = (l.brand || '').trim() || '未指定品牌'
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(l)
        }
        const list = []
        const errors = []
        for (const [vendor, lines] of groups) {
          try {
            const r = await api('rfq_create', { method: 'POST', body: JSON.stringify({
              opportunityNo: opp ? opp.no : '', opportunityName: opp ? opp.name : '',
              vendor: vendor, section, withMail: true,
              items: lines.map((l) => ({
                name: l.name, spec: l.spec, brand: l.brand, model: l.model, unit: l.unit,
                qty: l.qty, targetPrice: l.stdPrice, lineId: itemKey(l),
              })),
            }) })
            setCart((prev) => prev.map((x) => lines.some((l) => itemKey(l) === itemKey(x)) ? { ...x, rfqId: r.id, rfqNo: r.no } : x))
            if (r.mail) list.push({ ...r.mail, vendor, lineKey: itemKey(lines[0]) })
            else { const m = await api('rfq_mail?id=' + encodeURIComponent(r.id)); list.push({ ...m, rfqNo: r.no, vendor, lineKey: itemKey(lines[0]) }) }
          } catch (e) { errors.push(`${vendor}：${e.message || e}`) }
        }
        if (!list.length) { setMsg({ kind: 'err', text: `询价单创建失败：${errors.join('；')}` }); setBusy(false); return }
        setMailPreview(list[0]); setMailQueue(list.slice(1)); setMailTo(list[0].to || ''); setDraftMsg('')
        if (errors.length) setMsg({ kind: 'err', text: `部分失败：${errors.join('；')}` })
        setBusy(false)
        void loadRfqs()
      }

      async function saveRfqDraft() {
        if (!mailPreview) return
        if (!mailTo.trim()) { setDraftMsg('请先填收件人'); return }
        try {
          const r = await api('rfq_draft', { method: 'POST', body: JSON.stringify({ id: mailPreview.id || mailPreview.rfqId || '', account: mailFrom, to: mailTo }) })
          localStorage.setItem('presales.lastRfqFrom', mailFrom)
          setDraftMsg(`已存为邮件草稿 ${r.draft?.id || ''}（未发送，请到 设置→邮件→草稿 确认）`)
        } catch (e) { setDraftMsg(String(e.message || e)) }
      }

      async function fillRfqPrice(line) {
        const raw = window.prompt('请输入厂商回复的含税价（元）', String(line.stdPrice || ''))
        if (raw === null) return
        const price = Number(raw) || 0
        try {
          if (line.rfqId) await api('rfq_reply', { method: 'POST', body: JSON.stringify({ id: line.rfqId, price }) })
          setCart((prev) => prev.map((x) => (itemKey(x) === itemKey(line) ? { ...x, stdPrice: round(price / 1.13, 2), remark: '已询价回填' } : x)))
          setMsg({ kind: 'ok', text: `已回填含税价 ${price}，未税价 ${round(price / 1.13, 2)}` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      function add(p) {
        setCart((prev) => {
          const i = prev.findIndex((x) => x.code === p.code && (x.section || '') === section)
          if (i >= 0) {
            const next = prev.slice()
            next[i] = { ...next[i], qty: next[i].qty + 1 }
            return next
          }
          return [...prev, { ...p, category: p.l2 || '', remark: '', qty: 1, discount: 1, taxRate: p.taxRate || 0.13, section, uid: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]
        })
      }
      function patch(key, field, value) {
        setCart((prev) => prev.map((x) => itemKey(x) === key ? { ...x, [field]: value } : x))
      }
      function remove(key) { setCart((prev) => prev.filter((x) => itemKey(x) !== key)) }

      async function renderXlsx() {
        if (!lastQuote?.no) return
        setBusy(true); setMsg(null)
        try {
          const r = await api('render', { method: 'POST', body: JSON.stringify({ quoteNo: lastQuote.no }) })
          setLastQuote({ ...lastQuote, link: r.link || lastQuote.link })
          setMsg({ kind: 'ok', text: `Excel 已生成：${r.link || r.name}` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function save() {
        if (!customer) { setMsg({ kind: 'err', text: '请先选择客户' }); return }
        if (!cart.length) { setMsg({ kind: 'err', text: '请先添加产品' }); return }
        setBusy(true); setMsg(null)
        try {
          const r = await api('save', {
            method: 'POST',
            body: JSON.stringify({
              customerName: customer.name, customerNo: customer.code || '',
              opportunityNo: opp ? opp.no : '', template,
              localTemplateId: localTpl ? localTpl.id : '',
              localTemplateName: localTpl ? localTpl.name : '',
              items: cart.map((x) => x.temp ? ({ temp: true, code: x.code, name: x.name, spec: x.spec, brand: x.brand, model: x.model, unit: x.unit, qty: Number(x.qty) || 0, price: Number(x.stdPrice) || 0, section: x.section || '', category: x.category || '', remark: x.remark || '', taxRate: Number(x.taxRate) || 0.13 }) : ({ code: x.code, qty: Number(x.qty) || 0, discount: Number(x.discount) || 1, section: x.section || '', brand: x.brand, model: x.model, unit: x.unit, name: x.name, spec: x.spec, category: x.category || '', remark: x.remark || '', taxRate: Number(x.taxRate) || 0.13, stdPrice: Number(x.stdPrice) })),
            }),
          })
          setMsg({ kind: 'ok', text: `已生成 ${r.quoteNo}（含税 ${money(r.grossTotal)}）`, link: r.link || '' })
          setLastQuote({ no: r.quoteNo, link: r.link || '', gross: r.grossTotal })
          setCart([])
          const qs = await api('quotes'); setQuotes(qs.items || [])
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function checkUpdates() {
        setBusy(true); setMsg(null)
        try {
          const r = await api('update_check')
          setUpdates(r.repos || [])
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function doUpdate(key) {
        setUpdating(key); setMsg(null)
        try {
          const r = await api('update', { method: 'POST', body: JSON.stringify({ key }) })
          setMsg({ kind: 'ok', text: `已更新 ${r.installed}，请完全重启 DSH 生效` })
          await checkUpdates()
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setUpdating('') }
      }

      function renderUpdateCard() {
        return h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'presales-muted' }, '插件更新（GitHub Releases）'),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void checkUpdates() }, '检查更新')),
          updates ? h('div', null, updates.map((u) => {
            const label = (u.key === 'cnbm' ? 'cnbm知识库' : '数字售前') + ` 本地 ${u.local || '?'} · 最新 ${u.latest || '?'}` + (u.hasUpdate ? ' · 有更新' : '')
            return h('div', { key: u.key, className: 'presales-row', style: { justifyContent: 'space-between', marginTop: 8 } },
              h('span', null, label),
              u.error ? h('span', { className: 'presales-muted' }, u.error)
                : u.hasUpdate ? h('button', { className: 'presales-btn', type: 'button', disabled: Boolean(updating), onClick: () => void doUpdate(u.key) }, updating === u.key ? '更新中…' : '更新')
                  : h('span', { className: 'presales-muted' }, '已是最新'))
          })) : null,
          h('div', { className: 'presales-muted', style: { marginTop: 6 } }, '仓库：xingkongge/dsh-cnbm-wps365、xingkongge/dsh-presales（公开）'))
      }

      function getSvc(name) {
        try {
          if (clientCtx && typeof clientCtx.get === 'function') {
            const v = clientCtx.get(name)
            if (v) return v
          }
        } catch { /* ignore */ }
        if (name === 'uiWorkspace') return uiWorkspace
        if (name === 'layout') return uiLayout
        return null
      }

      async function syncTemplates() {
        setBusy(true); setMsg(null)
        try {
          const r = await api('template_sync', { method: 'POST' })
          setMsg({ kind: 'ok', text: `模板已同步：更新 ${r.updated || 0}、新增 ${r.created || 0}、停用 ${r.disabled || 0}` })
          await load()
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function pickLocalTemplate(file) {
        if (!file) return
        setBusy(true); setMsg(null)
        try {
          const buf = await file.arrayBuffer()
          let binary = ''
          const bytes = new Uint8Array(buf)
          const chunk = 0x8000
          for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
          const data = btoa(binary)
          const r = await api('template_local', { method: 'POST', body: JSON.stringify({ name: file.name, data }) })
          setLocalTpl({ id: r.id, name: r.name })
          setMsg({ kind: 'ok', text: `已载入本地模板：${r.name}（仅本次使用，不写入 WPS）` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
      }

      async function scanTemplates() {
        setBusy(true); setMsg(null)
        try {
          const r = await api('template_scan', { method: 'POST' })
          setMsg({ kind: 'ok', text: `已扫描模板目录，新增 ${r.added || 0} 个自定义模板` })
          await load()
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      async function toggleUpdates() {
        const next = !updatesOpen
        setUpdatesOpen(next)
        if (next && !updates) await checkUpdates()
      }

      async function newOppChat() {
        const prompt = oppPrompt || FALLBACK_OPP_PROMPT
        const svc = getSvc('uiWorkspace')
        const sessions = getSvc('sessions')
        const lay = getSvc('layout')
        const copyPrompt = () => {
          try { navigator.clipboard.writeText(prompt) } catch { /* ignore */ }
          setChatNotice('已把「新建商机」提示词复制到剪贴板：请点左上角「新建会话」后直接粘贴发送。')
        }
        if (!svc && !sessions) { setChatNotice('当前拿不到会话服务。已复制提示词，请手动新建会话粘贴。'); copyPrompt(); return }
        try {
          // 优先：直接创建并打开一个新会话，再发送提示
          if (sessions && typeof sessions.create === 'function') {
            const id = await sessions.create({})
            if (id) {
              if (svc && typeof svc.openSession === 'function') svc.openSession(id)
              if (lay && typeof lay.selectPanel === 'function') lay.selectPanel(null)
              await sessions.using(id, { source: 'controllerOperation' }, async (ref) => {
                await ref.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
              })
              setChatNotice('已新建会话并发送「新建商机」提示；直接补充客户和金额即可。')
              return
            }
          }
          // 退路：走 DSH 自己的「新建会话」，再识别新出现的会话并发送提示
          const before = new Set((sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().ids : []) || [])
          if (svc && typeof svc.startSession === 'function') svc.startSession()
          if (lay && typeof lay.selectPanel === 'function') lay.selectPanel(null)
          let newId = null
          for (let i = 0; i < 20 && !newId; i += 1) {
            await new Promise((r) => setTimeout(r, 100))
            const ids = (sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().ids : []) || []
            newId = ids.find((x) => !before.has(x)) || null
          }
          if (newId && sessions && typeof sessions.using === 'function') {
            await sessions.using(newId, { source: 'controllerOperation' }, async (ref) => {
              await ref.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
            })
            setChatNotice('已新建会话并发送「新建商机」提示；直接补充客户和金额即可。')
          } else {
            copyPrompt()
            setChatNotice('已打开空白会话并复制提示词：在输入框粘贴后发送即可。')
          }
        } catch (e) {
          setChatNotice('新建会话失败：' + String(e.message || e) + '（已复制提示词，可手动新建会话粘贴）')
          try { navigator.clipboard.writeText(prompt) } catch { /* ignore */ }
        }
      }

      async function newCustomerChat() {
        let prompt = FALLBACK_CUSTOMER_PROMPT
        try { const r = await api('customer_prompt'); if (r?.prompt) prompt = r.prompt } catch {}
        const svc = getSvc('uiWorkspace')
        const sessions = getSvc('sessions')
        const lay = getSvc('layout')
        const copyPrompt = () => { try { navigator.clipboard.writeText(prompt) } catch {} ; setChatNotice('已复制「新建客户」提示词：请新建会话后粘贴发送。') }
        if (!svc && !sessions) { copyPrompt(); return }
        try {
          if (sessions && typeof sessions.create === 'function') {
            const id = await sessions.create({})
            if (id) {
              if (svc && typeof svc.openSession === 'function') svc.openSession(id)
              if (lay && typeof lay.selectPanel === 'function') lay.selectPanel(null)
              await sessions.using(id, { source: 'controllerOperation' }, async (ref) => {
                await ref.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
              })
              setChatNotice('已新建会话并发送「新建客户」提示；告诉它客户全称和省市即可。')
              return
            }
          }
          const before = new Set((sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().ids : []) || [])
          if (svc && typeof svc.startSession === 'function') svc.startSession()
          if (lay && typeof lay.selectPanel === 'function') lay.selectPanel(null)
          let newId = null
          for (let i = 0; i < 20 && !newId; i += 1) {
            await new Promise((r) => setTimeout(r, 100))
            const ids = (sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().ids : []) || []
            newId = ids.find((x) => !before.has(x)) || null
          }
          if (newId && sessions && typeof sessions.using === 'function') {
            await sessions.using(newId, { source: 'controllerOperation' }, async (ref) => {
              await ref.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
            })
            setChatNotice('已新建会话并发送「新建客户」提示；告诉它客户全称和省市即可。')
          } else { copyPrompt() }
        } catch (e) { setChatNotice('新建会话失败：' + String(e.message || e) + '（已复制提示词，可手动粘贴）'); copyPrompt() }
      }

      const tabBtn = (id, label) => h('button', {
        key: id, className: 'presales-tab', type: 'button', role: 'tab', 'aria-selected': tab === id,
        onClick: () => setTab(id),
      }, label)

      async function saveRfqPrice(item) {
        try {
          await api('rfq_item_price', { method: 'POST', body: JSON.stringify({ itemId: item.id, price: Number(rfqPrices[item.id]) || 0 }) })
          const d = await api('rfq_detail?id=' + encodeURIComponent(rfqView.header['询价编号'])); setRfqView(d)
          await loadRfqs()
          setMsg({ kind: 'ok', text: `已回填「${item['产品名称']}」` })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function saveRfqEmail() {
        try {
          await api('rfq_update', { method: 'POST', body: JSON.stringify({ id: rfqView.header.id, vendorEmail: rfqEmail }) })
          setRfqView(await api('rfq_detail?id=' + encodeURIComponent(rfqView.header['询价编号'])))
          setMsg({ kind: 'ok', text: '厂商邮箱已保存' })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function resendRfq() {
        try {
          const m = await api('rfq_mail?id=' + encodeURIComponent(rfqView.header.id))
          setMailPreview(m); setMailTo(m.to || ''); setMailQueue([]); setDraftMsg('')
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function openCustomer(key) {
        try { setCustDetail(await api('customer_get?key=' + encodeURIComponent(key))) }
        catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function saveCustomer() {
        if (!custForm || !String(custForm['客户名称'] || '').trim()) { setMsg({ kind: 'err', text: '客户名称必填' }); return }
        try {
          const r = await api('customer_save', { method: 'POST', body: JSON.stringify(custForm) })
          setCustForm(null)
          setMsg({ kind: 'ok', text: `客户已保存：${r.no || custForm['客户名称']}` })
          await load()
          if (r.no) await openCustomer(r.no)
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function lookupCustomer() {
        const name = String(custForm?.['客户名称'] || '').trim()
        if (!name) { setMsg({ kind: 'err', text: '请先填客户名称' }); return }
        setLookupBusy(true); setLookupSources([]); setMsg({ kind: 'ok', text: '正在联网查询工商信息（约 10~20 秒）…' })
        try {
          const r = await api('customer_lookup?name=' + encodeURIComponent(name) + '&region=' + encodeURIComponent(custForm['省市'] || ''))
          setCustForm({ ...custForm, ...(r.fields || {}), '信息来源': '联网检索', '来源链接': (r.sources || []).map((x) => x.url).join('\n') })
          setLookupSources(r.sources || [])
          const n = Object.keys(r.fields || {}).length
          setMsg({ kind: n ? 'ok' : 'err', text: n ? `已填入 ${n} 个字段，请核对后保存` : '没有检索到可用的工商字段，请手动填写' })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setLookupBusy(false) }
      }

      function customerField(key, label, type = 'text') {
        return h('label', null, h('span', { className: 'presales-label' }, label),
          h('input', { className: 'presales-input', type, value: custForm?.[key] ?? '', onChange: (e) => setCustForm({ ...custForm, [key]: e.target.value }) }))
      }

      function renderCustomerTab() {
        if (custForm) {
          return h('section', { className: 'presales-card' },
            h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
              h('b', null, custForm.id ? '编辑客户' : '新建客户'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => setCustForm(null) }, '取消')),
            h('div', { className: 'presales-grid', style: { marginTop: 8 } },
              h('label', null, h('span', { className: 'presales-label' }, h('span', null, '客户名称 '), h('button', { className: 'presales-btn', type: 'button', style: { padding: '2px 8px', fontSize: 12 }, disabled: lookupBusy, onClick: () => void lookupCustomer() }, lookupBusy ? '查询中…' : '联网查询')),
                h('input', { className: 'presales-input', value: custForm?.['客户名称'] ?? '', onChange: (e) => setCustForm({ ...custForm, '客户名称': e.target.value }) })),
              customerField('省市', '省市'), customerField('行业门类一级', '行业门类一级'), customerField('行业门类二级', '行业门类二级'),
              customerField('法定代表人', '法定代表人'), customerField('注册资本', '注册资本'), customerField('成立时间', '成立时间', 'date'), customerField('地址', '地址'),
              customerField('联系人', '联系人'), customerField('联系电话', '联系电话'), customerField('负责人', '负责人')),
            h('label', null, h('span', { className: 'presales-label' }, '客户简介'),
              h('textarea', { className: 'presales-input', style: { minHeight: 70 }, value: custForm['客户简介'] || '', onChange: (e) => setCustForm({ ...custForm, '客户简介': e.target.value }) })),
            msg ? h('div', { className: `presales-msg ${msg.kind === 'ok' ? 'ok' : 'err'}` }, msg.text) : null,
            lookupSources.length ? h('div', { className: 'presales-muted', style: { marginTop: 6 } }, '来源：' + lookupSources.map((x) => x.title || x.url).join(' / ')) : null,
            h('div', { className: 'presales-row', style: { marginTop: 8 } },
              h('button', { className: 'presales-btn primary', type: 'button', disabled: lookupBusy, onClick: () => void saveCustomer() }, lookupBusy ? '查询中…' : '保存')))
        }
        if (custDetail) {
          const c = custDetail.customer
          return h('section', { className: 'presales-card' },
            h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
              h('div', null, h('b', null, c['客户名称']), h('div', { className: 'presales-muted' }, `${c['客户编号'] || ''} · ${c['省市'] || ''} · ${c['行业'] || ''}`)),
              h('div', { className: 'presales-row' },
                h('button', { className: 'presales-btn', type: 'button', onClick: () => { setCustDetail(null); setCustForm({ ...c, id: c._id }) } }, '编辑'),
                h('button', { className: 'presales-btn', type: 'button', onClick: () => setCustDetail(null) }, '← 返回列表'))),
            h('div', { className: 'presales-grid', style: { marginTop: 10 } },
              h('div', null, h('div', { className: 'presales-label' }, '法定代表人'), c['法定代表人'] || '-'),
              h('div', null, h('div', { className: 'presales-label' }, '注册资本'), c['注册资本'] || '-'),
              h('div', null, h('div', { className: 'presales-label' }, '成立时间'), c['成立时间'] || '-'),
              h('div', null, h('div', { className: 'presales-label' }, '负责人'), c['负责人'] || '-')),
            h('div', { className: 'presales-muted', style: { marginTop: 8 } }, `地址：${c['地址'] || '-'} · 联系人：${c['联系人'] || '-'} ${c['联系电话'] || ''}`),
            c['客户简介'] ? h('div', { style: { marginTop: 8 } }, c['客户简介']) : null,
            h('div', { className: 'presales-label', style: { marginTop: 12 } }, `关联商机（${custDetail.opportunities.length}）`),
            custDetail.opportunities.length ? h('ul', { className: 'presales-list' }, custDetail.opportunities.map((o) => h('li', { key: o._id },
              h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
                h('span', null, h('b', null, o['商机编号']), ` ${o['商机名称']}`), h('span', null, `${o['阶段'] || ''} · ${o['金额'] || 0} 万`))))) : h('div', { className: 'presales-muted' }, '暂无关联商机'))
        }
        const q = custQuery.trim().toLowerCase()
        const rows = customers.filter((c) => !q || `${c.name} ${c.code} ${c.industry}`.toLowerCase().includes(q))
        return h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'presales-row' },
              h('input', { className: 'presales-input', style: { maxWidth: 280 }, placeholder: '搜客户名称/编号/行业', value: custQuery, onChange: (e) => setCustQuery(e.target.value) }),
              h('span', { className: 'presales-muted' }, `共 ${rows.length} 个客户`)),
            h('div', { className: 'presales-row' },
              h('button', { className: 'presales-btn', type: 'button', onClick: () => setCustForm({ '客户名称': '', '状态': '正常' }) }, '新建客户'),
              h('button', { className: 'presales-btn primary', type: 'button', onClick: () => void newCustomerChat() }, '新建客户（对话）'))),
          h('table', { className: 'presales-table', style: { marginTop: 8 } },
            h('thead', null, h('tr', null, ['客户名称', '编号', '省市', '行业', '负责人', '状态'].map((t) => h('th', { key: t }, t)))),
            h('tbody', null, rows.map((c) => h('tr', { key: c.id, style: { cursor: 'pointer' }, onClick: () => void openCustomer(c.id) },
              h('td', null, h('b', null, c.name)), h('td', null, c.code), h('td', null, c.region || '-'), h('td', null, c.industry || '-'), h('td', null, c.owner || '-'), h('td', null, c.status || '-'))))))
      }

      function renderMailCard() {
        return (mailPreview ? h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('b', null, `询价邮件 ${mailPreview.rfqNo || ''}`),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => setMailPreview(null) }, '关闭')),
          h('div', { className: 'presales-grid', style: { marginTop: 8 } },
            h('label', null, h('span', { className: 'presales-label' }, '发件账号（默认上次）'),
              h('select', { className: 'presales-select', value: mailFrom, onChange: (e) => setMailFrom(e.target.value) },
                mailAccounts.length ? null : h('option', { value: '' }, '未检测到邮箱账号'),
                mailAccounts.map((a) => h('option', { key: a.name, value: a.name }, a.label || a.name)))),
            h('label', null, h('span', { className: 'presales-label' }, '收件人（请确认）'),
              h('input', { className: 'presales-input', value: mailTo, onChange: (e) => setMailTo(e.target.value), placeholder: 'vendor@example.com' }))),
          h('div', { className: 'presales-label', style: { marginTop: 6 } }, '主题'),
          h('input', { className: 'presales-input', readOnly: true, value: mailPreview.subject || '' }),
          h('div', { className: 'presales-label', style: { marginTop: 6 } }, '正文'),
          h('textarea', { className: 'presales-input', style: { minHeight: 180 }, readOnly: true, value: mailPreview.text || '' }),
          draftMsg ? h('div', { className: 'presales-muted', style: { marginTop: 6 } }, draftMsg) : null,
          h('div', { className: 'presales-row', style: { marginTop: 8 } },
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void saveRfqDraft() }, '存为邮件草稿（不发送）'),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void markMailSent() }, '标记已发送'),
            mailQueue.length ? h('button', { className: 'presales-btn', type: 'button', onClick: () => nextMail() }, `下一封（剩 ${mailQueue.length}）`) : null,
            h('button', { className: 'presales-btn', type: 'button', onClick: () => { navigator.clipboard.writeText(`${mailPreview.subject}\n\n${mailPreview.text}`) } }, '复制主题+正文'),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => {
              api('open_mailto', { method: 'POST', body: JSON.stringify({ subject: mailPreview.subject || '', text: mailPreview.text || '' }) })
                .then(() => setDraftMsg('已调用系统默认邮件客户端'))
                .catch((e) => setDraftMsg(`打开失败：${e.message || e}`))
            } }, '打开邮件客户端'))) : null)
      }

      function renderRfqTab() {
        if (rfqView) {
          const rows = rfqView.items.map((it) => h('tr', { key: it.id },
            h('td', null, it['产品名称']),
            h('td', null, `${it['数量']} ${it['单位'] || ''}`),
            h('td', null, it['目标价（含税）'] ?? '-'),
            h('td', null, h('input', { type: 'number', min: 0, value: rfqPrices[it.id] ?? '', onChange: (e) => setRfqPrices({ ...rfqPrices, [it.id]: e.target.value }) })),
            h('td', null, h('button', { className: 'presales-btn', type: 'button', onClick: () => void saveRfqPrice(it) }, '回填'))))
          return h('section', { className: 'presales-card' },
            h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
              h('b', null, `询价单 ${rfqView.header['询价编号']}`),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => setRfqView(null) }, '← 返回列表')),
            h('div', { className: 'presales-grid', style: { marginTop: 8 } },
              h('label', null, h('span', { className: 'presales-label' }, '品牌/厂商'), h('input', { className: 'presales-input', value: rfqView.header['厂商名称'] || '', readOnly: true })),
              h('label', null, h('span', { className: 'presales-label' }, '厂商邮箱'), h('input', { className: 'presales-input', value: rfqEmail, onChange: (e) => setRfqEmail(e.target.value) })),
              h('label', null, h('span', { className: 'presales-label' }, '状态'), h('input', { className: 'presales-input', value: rfqView.header['询价状态'] || '', readOnly: true }))),
            h('div', { className: 'presales-row', style: { marginTop: 8 } },
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void saveRfqEmail() }, '保存邮箱'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void resendRfq() }, '重发邮件'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void markMailSent() }, '标记已发送')),
            h('table', { className: 'presales-table', style: { marginTop: 8 } },
              h('thead', null, h('tr', null, ['产品', '数量', '目标价', '回复价（含税）', ''].map((t) => h('th', { key: t }, t)))),
              h('tbody', null, rows)))
        }
        const rows = rfqs.map((r) => h('li', { key: r.id, style: { cursor: 'pointer' }, onClick: () => void openRfq(r.no) },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('span', null, h('b', null, r.no), ` ${r.vendor || '未指定厂商'}`, h('span', { className: 'presales-muted' }, ` · ${r.itemCount} 项`)),
            h('span', null, r.status || '-'))))
        return h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('b', null, '询价单'),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void loadRfqs() }, '刷新')),
          rows.length ? h('ul', { className: 'presales-list', style: { marginTop: 8 } }, rows) : h('div', { className: 'presales-muted', style: { marginTop: 8 } }, '还没有询价单；勾选临时产品后点“生成询价单”'))
      }

      if (tab === 'rfq') {
        return h('div', { className: 'presales-panel' },
          h('header', { className: 'presales-head' },
            h('div', null,
              h('div', { className: 'presales-title' }, '数字售前'),
              h('div', { className: 'presales-sub' }, '商机推进 · 报价出单 · 询价协同')),
            h('div', { className: 'presales-row' },
              status ? h('button', { className: `presales-badge ${status.ok ? 'ok' : 'err'}`, type: 'button', onClick: () => setShowCounts(!showCounts) }, status.ok ? 'WPS 已连接' : '未连接') : null,
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void toggleUpdates() }, updatesOpen ? '收起更新' : '插件更新'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
          h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('customer', '客户'), tabBtn('opp', '商机'), tabBtn('quote', '报价'), tabBtn('rfq', '询价单')),
          updatesOpen ? renderUpdateCard() : null,
          renderRfqTab(),
          renderMailCard())
      }

      if (tab === 'customer') {
        return h('div', { className: 'presales-panel' },
          h('header', { className: 'presales-head' },
            h('div', null,
              h('div', { className: 'presales-title' }, '数字售前'),
              h('div', { className: 'presales-sub' }, '商机推进 · 报价出单 · 询价协同')),
            h('div', { className: 'presales-row' },
              status ? h('button', { className: `presales-badge ${status.ok ? 'ok' : 'err'}`, type: 'button', onClick: () => setShowCounts(!showCounts) }, status.ok ? 'WPS 已连接' : '未连接') : null,
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void toggleUpdates() }, updatesOpen ? '收起更新' : '插件更新'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
          h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('customer', '客户'), tabBtn('opp', '商机'), tabBtn('quote', '报价'), tabBtn('rfq', '询价单')),
          updatesOpen ? renderUpdateCard() : null,
          renderCustomerTab())
      }

      if (tab === 'opp') {
        return h('div', { className: 'presales-panel' },
          h('header', { className: 'presales-head' },
            h('div', null,
              h('div', { className: 'presales-title' }, '数字售前'),
              h('div', { className: 'presales-sub' }, '商机推进 · 报价出单 · 询价协同')),
            h('div', { className: 'presales-row' },
              status ? h('button', {
                className: `presales-badge ${status.ok ? 'ok' : 'err'}`,
                type: 'button', title: '点击查看产品/客户/报价数量',
                onClick: () => setShowCounts(!showCounts),
              }, status.ok ? 'WPS 已连接' : '未连接') : null,
              showCounts && status ? h('span', { className: 'presales-muted' }, `产品 ${status.counts?.products ?? '-'} · 客户 ${status.counts?.customers ?? '-'} · 报价 ${status.counts?.quotes ?? '-'}`) : null,
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void toggleUpdates() }, updatesOpen ? '收起更新' : '插件更新', updates && updates.some((u) => u.hasUpdate) ? h('span', { className: 'presales-dot' }) : null),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
          h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('customer', '客户'), tabBtn('opp', '商机'), tabBtn('quote', '报价'), tabBtn('rfq', '询价单')),
          updatesOpen ? renderUpdateCard() : null,
          chatNotice ? h('div', { className: 'presales-msg ok' }, chatNotice) : null,
          h(OppTab, { onQuote: () => setTab('quote'), onNewOpp: () => void newOppChat() }))
      }

      return h('div', { className: 'presales-panel' },
        h('header', { className: 'presales-head' }, 
          h('div', null,
            h('div', { className: 'presales-title' }, '数字售前'),
            h('div', { className: 'presales-sub' }, '商机推进 · 报价出单 · 询价协同')),
          h('div', { className: 'presales-row' },
            status ? h('button', {
              className: `presales-badge ${status.ok ? 'ok' : 'err'}`,
              type: 'button', title: '点击查看产品/客户/报价数量',
              onClick: () => setShowCounts(!showCounts),
            }, status.ok ? 'WPS 已连接' : '未连接') : null,
            showCounts && status ? h('span', { className: 'presales-muted' }, `产品 ${status.counts?.products ?? '-'} · 客户 ${status.counts?.customers ?? '-'} · 报价 ${status.counts?.quotes ?? '-'}`) : null,
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void toggleUpdates() }, updatesOpen ? '收起更新' : '插件更新', updates && updates.some((u) => u.hasUpdate) ? h('span', { className: 'presales-dot' }) : null),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
        h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('customer', '客户'), tabBtn('opp', '商机'), tabBtn('quote', '报价'), tabBtn('rfq', '询价单')),
        updatesOpen ? renderUpdateCard() : null,
        h('section', { className: 'presales-card' },
          h('div', { className: 'presales-grid' },
            h('label', null, h('span', { className: 'presales-label' }, '客户'), h('select', {
              className: 'presales-select', value: customerId,
              onChange: (e) => { setCustomerId(e.target.value); void loadOpps(e.target.value) },
            }, h('option', { value: '' }, '请选择客户'), customers.map((c) => h('option', { key: c.id, value: c.id }, `${c.name}${c.industry ? ' · ' + c.industry : ''}`)))),
            h('label', null, h('span', { className: 'presales-label' }, '商机（可选）'), h('select', {
              className: 'presales-select', value: oppId, onChange: (e) => setOppId(e.target.value),
            }, h('option', { value: '' }, opps.length ? '不关联商机' : '先选客户'), opps.map((o) => h('option', { key: o.id, value: o.id }, `${o.no} ${o.name}`)))),
            h('label', null, h('span', { className: 'presales-label' }, '报价模板'), h('select', {
              className: 'presales-select', value: template, onChange: (e) => setTemplate(e.target.value),
            }, templates.map((t) => h('option', { key: t.name, value: t.name }, `${t.name}${t.default ? '（默认）' : ''}`)))))),
          tplNotice ? h('div', { className: 'presales-row', style: { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', null, `模板文件有变化：新增 ${tplNotice.added?.length || 0} · 变更 ${tplNotice.updates?.length || 0} · 缺失 ${tplNotice.missing?.length || 0}`),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void syncTemplates() }, '同步模板记录')) : null,
          h('div', { className: 'presales-row', style: { marginTop: 8 } },
            h('input', { ref: fileRef, type: 'file', accept: '.xlsx', style: { display: 'none' }, onChange: (e) => void pickLocalTemplate(e.target.files && e.target.files[0]) }),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, '选择本地模板（一次性）'),
            localTpl ? h('span', { className: 'presales-muted' }, `已选：${localTpl.name}`) : h('span', { className: 'presales-muted' }, '自定义 xlsx 仅本次使用，不写入 WPS'),
            localTpl ? h('button', { className: 'presales-btn', type: 'button', onClick: () => setLocalTpl(null) }, '清除') : null),
        h('section', { className: 'presales-card' },

          h('div', { className: 'presales-row', style: { justifyContent: 'space-between', marginTop: 10 } },
            h('b', null, '产品分类'),
            cat.l1 ? h('button', { className: 'presales-btn', type: 'button', onClick: () => pickCat('', '') }, '全部') : h('span', { className: 'presales-muted' }, '点击分类筛选，或直接搜关键字')),
          h('div', { className: 'presales-tree' },
            cats.map((one) => h('div', { key: one.id },
              h('button', {
                className: 'presales-tree-l1' + (cat.l1 === one.name && !cat.l2 ? ' active' : ''),
                type: 'button',
                onClick: () => {
                  setExpanded((prev) => ({ ...prev, [one.id]: !prev[one.id] }))
                  pickCat(one.name, '')
                },
              }, h('span', null, expanded[one.id] ? '▾' : '▸'), one.name, h('span', { className: 'presales-muted' }, ` (${one.count})`)),
              expanded[one.id] ? h('div', { className: 'presales-tree-l2' },
                one.children.map((two) => h('button', {
                  key: two.id,
                  type: 'button',
                  className: cat.l2 === two.name ? 'active' : '',
                  onClick: () => pickCat(one.name, two.name),
                }, `${two.name} (${two.count})`))) : null))),
          !cats.length ? h('div', { className: 'presales-muted' }, '分类加载中…') : null),
        h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row' },
            h('input', {
              className: 'presales-input', style: { maxWidth: 360 }, placeholder: '搜产品名称/编码，如：安全、XYZL-SW',
              value: keyword, onChange: (e) => setKeyword(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void search() },
            }),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void search() }, '搜索')),
          results.length ? h('ul', { className: 'presales-results' }, results.map((p) => h('li', {
            key: p.code, onClick: () => add(p),
          }, h('span', null, h('b', null, p.name), h('span', { className: 'presales-muted' }, ` ${p.code} · ${p.unit} · 未税 ${money(p.stdPrice)}`)),
            h('span', { className: 'presales-btn' }, '加入')))) : null,
          h('div', { className: 'presales-muted', style: { marginTop: 8 } }, '点击结果加入明细；数量/折扣可在下表修改')),
        h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
            h('b', null, '报价分节'),
            sections.length ? h('select', { className: 'presales-select', style: { maxWidth: 260 }, value: section, onChange: (e) => setSection(e.target.value) },
              sections.map((x) => h('option', { key: x.title, value: x.title }, x.title))) : h('span', { className: 'presales-muted' }, '模板未识别到分节')),
          h('div', { className: 'presales-muted', style: { marginTop: 2 } }, '选分节后挂产品；明细行里也可改分节'),
          h('div', { className: 'presales-row', style: { marginTop: 8 } },
            h('button', { className: 'presales-btn', type: 'button', onClick: () => { setTempOpen(!tempOpen); setTempForm({ name: '', spec: '', brand: '', model: '', unit: '项', qty: 1, price: '' }) } }, tempOpen ? '取消新增' : '＋ 新增临时产品'),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void syncRfqReplies() }, '同步询价回复'),
            h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void batchMail() }, `生成询价单（${Object.values(selected).filter(Boolean).length} 项）`)),

          (cart.length || tempOpen) ? h('table', { className: 'presales-table', style: { minWidth: 1500 } },
            h('thead', null, h('tr', null,
              ['选', '序号', '产品', '规格', '分节', '产品类型', '品牌', '型号', '单位', '未税单价', '数量', '折扣', '税率', '含税小计', '备注', ''].map((t) => h('th', { key: t }, t)))),
            h('tbody', null, cart.map((l, rowIndex) => {
              const rowNo = rowIndex + 1
              const unit = round(l.stdPrice * l.discount, 4)
              const gross = round(round(unit * l.qty, 2) * (1 + l.taxRate), 2)
              return h('tr', { key: itemKey(l) },
                h('td', null, l.temp ? h('input', { type: 'checkbox', checked: Boolean(selected[itemKey(l)]), onChange: () => toggleSelect(itemKey(l)) }) : null),
                h('td', null, rowNo),
                h('td', null, h('input', { className: 'presales-input', style: { width: 180 }, value: l.name, onChange: (e) => patch(itemKey(l), 'name', e.target.value) }), l.temp ? h('span', { className: 'presales-badge' }, '临时') : null, h('div', { className: 'presales-muted' }, `${l.code}${l.rfqNo ? ' · ' + l.rfqNo : ''}`)),
                h('td', null, h('input', { className: 'presales-input', style: { width: 160 }, value: l.spec || '', onChange: (e) => patch(itemKey(l), 'spec', e.target.value) })),
                h('td', null, h('select', { className: 'presales-select', style: { maxWidth: 150 }, value: l.section || section, onChange: (e) => patch(itemKey(l), 'section', e.target.value) },
                  (sections.length ? sections.map((x) => x.title) : [l.section || section || '产品报价']).map((t) => h('option', { key: t, value: t }, t)))),
                h('td', null, h('input', { className: 'presales-input', style: { width: 100 }, value: l.category || '', onChange: (e) => patch(itemKey(l), 'category', e.target.value) })),
                h('td', null, h('input', { className: 'presales-input', style: { width: 90 }, value: l.brand || '', onChange: (e) => patch(itemKey(l), 'brand', e.target.value) })),
                h('td', null, h('input', { className: 'presales-input', style: { width: 110 }, value: l.model || '', onChange: (e) => patch(itemKey(l), 'model', e.target.value) })),
                h('td', null, h('input', { className: 'presales-input', style: { width: 55 }, value: l.unit || '', onChange: (e) => patch(itemKey(l), 'unit', e.target.value) })),
                h('td', null, h('input', { type: 'number', min: 0, style: { width: 90 }, value: l.stdPrice, onChange: (e) => patch(itemKey(l), 'stdPrice', Number(e.target.value)) })),
                h('td', null, h('input', { type: 'number', min: 0, style: { width: 60 }, value: l.qty, onChange: (e) => patch(itemKey(l), 'qty', Number(e.target.value)) })),
                h('td', null, h('input', { type: 'number', min: 0.01, max: 1, step: 0.01, style: { width: 60 }, value: l.discount, onChange: (e) => patch(itemKey(l), 'discount', Number(e.target.value)) })),
                h('td', null, h('input', { type: 'number', min: 0, max: 1, step: 0.01, style: { width: 60 }, value: l.taxRate ?? 0.13, onChange: (e) => patch(itemKey(l), 'taxRate', Number(e.target.value)) })),
                h('td', null, money(gross)),
                h('td', null, h('input', { className: 'presales-input', style: { width: 120 }, value: l.remark || '', onChange: (e) => patch(itemKey(l), 'remark', e.target.value) })),
                h('td', null,
                  l.temp ? h('button', { className: 'presales-btn', type: 'button', onClick: () => void fillRfqPrice(l) }, '回填价') : null,
                  h('button', { className: 'presales-btn', type: 'button', onClick: () => remove(itemKey(l)) }, '移除')))
            }),
            tempOpen ? h('tr', { className: 'presales-draft' },
              h('td', null, h('input', { type: 'checkbox', checked: tempRfq, onChange: (e) => setTempRfq(e.target.checked) })),
              h('td', null, '-'),
              h('td', null, h('input', { className: 'presales-input', placeholder: '临时产品名称', value: tempForm.name, onChange: (e) => setTempForm({ ...tempForm, name: e.target.value }) })),
              h('td', null, h('input', { className: 'presales-input', style: { width: 160 }, value: tempForm.spec || '', onChange: (e) => setTempForm({ ...tempForm, spec: e.target.value }) })),
              h('td', null, h('select', { className: 'presales-select', value: tempForm.section || section, onChange: (e) => setTempForm({ ...tempForm, section: e.target.value }) },
                (sections.length ? sections.map((x) => x.title) : [section || '产品报价']).map((t) => h('option', { key: t, value: t }, t)))),
              h('td', null, h('input', { className: 'presales-input', style: { width: 100 }, value: tempForm.category || '', onChange: (e) => setTempForm({ ...tempForm, category: e.target.value }) })),
              h('td', null, h('input', { className: 'presales-input', style: { width: 90 }, value: tempForm.brand, onChange: (e) => setTempForm({ ...tempForm, brand: e.target.value }) })),
              h('td', null, h('input', { className: 'presales-input', style: { width: 110 }, value: tempForm.model, onChange: (e) => setTempForm({ ...tempForm, model: e.target.value }) })),
              h('td', null, h('input', { className: 'presales-input', style: { width: 55 }, value: tempForm.unit, onChange: (e) => setTempForm({ ...tempForm, unit: e.target.value }) })),
              h('td', null, h('input', { type: 'number', min: 0, style: { width: 90 }, value: tempForm.price, onChange: (e) => setTempForm({ ...tempForm, price: e.target.value }) })),
              h('td', null, h('input', { type: 'number', min: 0, style: { width: 60 }, value: tempForm.qty, onChange: (e) => setTempForm({ ...tempForm, qty: Number(e.target.value) }) })),
              h('td', null, '-'),
              h('td', null, h('input', { type: 'number', min: 0, max: 1, step: 0.01, style: { width: 60 }, value: 0.13, readOnly: true })),
              h('td', null, money(round((Number(tempForm.price) || 0) * (Number(tempForm.qty) || 0) * 1.13, 2))),
              h('td', null, h('input', { className: 'presales-input', style: { width: 120 }, value: tempForm.remark || '', onChange: (e) => setTempForm({ ...tempForm, remark: e.target.value }) })),
              h('td', null,
                h('button', { className: 'presales-btn primary', type: 'button', onClick: () => void addTemp() }, '保存'))) : null,
            )) : h('div', { className: 'presales-muted' }, '还没有明细；先从上面选分节、挂产品，或新增临时产品'),
          h('div', { className: 'presales-total', style: { marginTop: 12 } },
            h('span', null, '未税 ', h('b', null, money(totals.untaxed))),
            h('span', null, '税额 ', h('b', null, money(totals.tax))),
            h('span', null, '含税 ', h('b', null, money(totals.gross))),
            h('span', null, '毛利率 ', h('b', null, totals.margin == null ? '-' : (totals.margin * 100).toFixed(2) + '%'))),
          h('div', { className: 'presales-row', style: { marginTop: 12 } },
            h('button', { className: 'presales-btn primary', type: 'button', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '生成报价单'))),

        renderMailCard(),
        msg ? h('div', { className: `presales-msg ${msg.kind === 'ok' ? 'ok' : 'err'}` },
          msg.text,
          msg.link ? h('a', { href: msg.link, target: '_blank', rel: 'noreferrer', style: { marginLeft: 10, color: 'inherit', textDecoration: 'underline' } }, '打开 / 下载') : null) : null,
        lastQuote ? h('section', { className: 'presales-card' },
          h('div', { className: 'presales-row' },
            h('div', null,
              h('div', { className: 'presales-muted' }, '本次生成'),
              h('div', null, h('b', null, lastQuote.no), ` · 含税 ${money(lastQuote.gross)}`)),
            h('div', { className: 'presales-row' },
              lastQuote.link ? h('a', { className: 'presales-btn', href: lastQuote.link, target: '_blank', rel: 'noreferrer' }, '打开 / 下载') : null,
              h('button', { className: 'presales-btn', type: 'button', disabled: busy, onClick: () => void renderXlsx() }, '重新生成 Excel')))) : null,
        h('section', { className: 'presales-card' },
          h('div', { className: 'presales-muted', style: { marginBottom: 6 } }, '最近报价'),
          quotes.length ? h('ul', { className: 'presales-quotes' }, quotes.map((q) => h('li', { key: q.quoteNo },
            h('span', null, h('b', null, q.quoteNo), ` ${q.customerName || ''} · ${q.status}`),
            h('span', null, q.link ? h('a', { href: q.link, target: '_blank', rel: 'noreferrer', style: { marginRight: 10 } }, '打开') : null, `含税 ${money(q.grossTotal)}`)))) : h('div', { className: 'presales-muted' }, '暂无')))
    }

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        if (this.state.error) {
          return h('div', { className: 'presales-panel' }, h('section', { className: 'presales-card' },
            '报价工作台加载失败：' + String((this.state.error && this.state.error.message) || this.state.error)))
        }
        return this.props.children
      }
    }

    function Icon({ size = 20, active } = {}) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: active ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M7 9h10M7 13h6M7 17h4', stroke: active ? 'var(--dsw-alias-bg-base)' : 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function ensureStyles(ctx) {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_MARK + '"]')) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_MARK)
      style.textContent = STYLE
      document.head.appendChild(style)
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => () => { if (style.parentNode) style.parentNode.removeChild(style) })
    }

    return {
      name: '@cnbm/dsh-presales',
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        try { ensureStyles(ctx) } catch { /* ignore */ }
        try { uiWorkspace = ctx.get('uiWorkspace') || null } catch { uiWorkspace = null }
        try { uiLayout = ctx.get('layout') || null } catch { uiLayout = null }
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['uiWorkspace', 'layout'], (sub) => {
              uiWorkspace = sub.uiWorkspace || uiWorkspace
              uiLayout = sub.layout || uiLayout
            })
          }
        } catch { /* 忽略：点击时会再取一次 */ }
        const safe = (slot, register) => {
          try { ctx.slots.inject(slot, register) } catch (e) { try { ctx.logger?.warn?.(`[presales] ${slot} 注册失败：${e && e.message}`) } catch { /* ignore */ } }
        }
        safe('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '数字售前',
        }, (props) => h(Icon, props || {})))
        safe('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, (props) => h(Boundary, null, h(Panel, props || {}))))
      },
    }
  },
})
