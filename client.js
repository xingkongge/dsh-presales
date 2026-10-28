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
    const NEW_OPP_PROMPT = `你是数字售前助手，请用自然语言帮我新建商机。\n\n直接说清楚：客户名称、商机名称、金额（万元）、阶段、预计落单时间、联系人/电话、行业、项目简介。\n例如：给华东某化工集团新建商机「双重预防平台」，金额 386 万，阶段需求沟通，预计 2026-11-20 落单，联系人王工。\n\n我会先调 opp_list 查重，再用 opp_create 建档；缺字段会追问。`
    const API = '/presales/api/'
    const HDR = { 'x-dsh-presales': '1' }

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
.presales-btn{padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}
.presales-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.presales-btn.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-invert,#fff);border-color:transparent;font-weight:600}
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
.presales-badge.ok{color:var(--dsw-alias-state-success-primary)}
.presales-badge.err{color:var(--dsw-alias-state-error-primary)}
.presales-badge.warn{color:var(--dsw-alias-state-warn-primary)}
.presales-quotes{list-style:none;margin:0;padding:0}
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

    function OppTab({ onQuote, onReload }) {
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

      async function load() {
        try {
          const [ls, bd] = await Promise.all([api('opps?keyword=' + encodeURIComponent(keyword) + '&stage=' + encodeURIComponent(stage)), api('opp_board')])
          setItems(ls.items || []); setBoard(bd)
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
          h('div', { className: 'presales-row' },
            h('input', { className: 'presales-input', style: { maxWidth: 300 }, placeholder: '搜商机名称/客户/编号', value: keyword, onChange: (e) => setKeyword(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void load() } }),
            h('select', { className: 'presales-select', style: { maxWidth: 150 }, value: stage, onChange: (e) => { setStage(e.target.value); setTimeout(() => void load(), 0) } },
              h('option', { value: '' }, '全部阶段'), STAGES.map((s) => h('option', { key: s, value: s }, s))),
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '查询'))),
        board ? h('section', { className: 'presales-card' },
          h('div', { className: 'presales-total' },
            h('span', null, '商机 ', h('b', null, board.total)),
            h('span', null, '总金额 ', h('b', null, board.amount.toFixed(0)), ' 万'),
            h('span', null, '赢单 ', h('b', null, board.won)),
            h('span', null, '赢单率 ', h('b', null, board.total ? ((board.won / board.total) * 100).toFixed(0) + '%' : '-'))),
          h('div', { className: 'presales-muted', style: { marginTop: 8 } }, board.stages.map((s) => `${s.name} ${s.n}/${s.amount.toFixed(0)}万`).join(' · '))) : null,
        h('section', { className: 'presales-card' },
          items.length ? h('ul', { className: 'presales-list' }, items.map((o) => h('li', { key: o.id, style: { cursor: 'pointer' }, onClick: () => void open(o.no) },
            h('div', { className: 'presales-row', style: { justifyContent: 'space-between' } },
              h('span', null, h('b', null, o.no), ` ${o.name}`, h('span', { className: 'presales-muted' }, ` · ${o.customerName}`)),
              h('span', null, `${o.stage} · ${o.amount} 万`))))) : h('div', { className: 'presales-muted' }, '没有商机')),
        msg ? h('div', { className: `presales-msg ${msg.kind === 'ok' ? 'ok' : 'err'}` }, msg.text) : null)
    }

    function Panel() {
      const [tab, setTab] = React.useState('opp')
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
      const [cart, setCart] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [lastQuote, setLastQuote] = React.useState(null)
      const [updates, setUpdates] = React.useState(null)
      const [updating, setUpdating] = React.useState('')
      const [chatNotice, setChatNotice] = React.useState('')
      const [msg, setMsg] = React.useState(null)

      const customer = customers.find((c) => c.id === customerId) || null
      const opp = opps.find((o) => o.id === oppId) || null
      const totals = computeTotals(cart)

      async function load() {
        try {
          const [s, cs, tpl, qs] = await Promise.all([
            api('status'), api('customers'), api('templates'), api('quotes'),
          ])
          setStatus(s); setCustomers(cs.items || [])
          setTemplates(tpl.items || [])
          setQuotes(qs.items || [])
          const def = (tpl.items || []).find((x) => x.default) || (tpl.items || [])[0]
          if (def) setTemplate(def.name)
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }
      React.useEffect(() => { void load() }, [])

      async function loadOpps(cid) {
        setOpps([]); setOppId('')
        if (!cid) return
        try {
          const r = await api('opportunities?customerId=' + encodeURIComponent(cid))
          setOpps(r.items || [])
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) }
      }

      async function search() {
        if (busy) return
        setBusy(true); setMsg(null)
        try {
          const r = await api('products?keyword=' + encodeURIComponent(keyword) + '&limit=20')
          setResults(r.items || [])
          if (!(r.items || []).length) setMsg({ kind: 'err', text: '没有匹配的在售产品' })
        } catch (e) { setMsg({ kind: 'err', text: String(e.message || e) }) } finally { setBusy(false) }
      }

      function add(p) {
        setCart((prev) => {
          const i = prev.findIndex((x) => x.code === p.code)
          if (i >= 0) {
            const next = prev.slice()
            next[i] = { ...next[i], qty: next[i].qty + 1 }
            return next
          }
          return [...prev, { ...p, qty: 1, discount: 1, taxRate: p.taxRate || 0.13 }]
        })
      }
      function patch(code, key, value) {
        setCart((prev) => prev.map((x) => x.code === code ? { ...x, [key]: value } : x))
      }
      function remove(code) { setCart((prev) => prev.filter((x) => x.code !== code)) }

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
              items: cart.map((x) => ({ code: x.code, qty: Number(x.qty) || 0, discount: Number(x.discount) || 1 })),
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

      async function newOppChat() {
        const svc = getSvc('uiWorkspace')
        const sessions = getSvc('sessions')
        const lay = getSvc('layout')
        const copyPrompt = () => {
          try { navigator.clipboard.writeText(NEW_OPP_PROMPT) } catch { /* ignore */ }
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
                await ref.binding.session.prompt([{ type: 'text', text: NEW_OPP_PROMPT }], 'queue')
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
              await ref.binding.session.prompt([{ type: 'text', text: NEW_OPP_PROMPT }], 'queue')
            })
            setChatNotice('已新建会话并发送「新建商机」提示；直接补充客户和金额即可。')
          } else {
            copyPrompt()
            setChatNotice('已打开空白会话并复制提示词：在输入框粘贴后发送即可。')
          }
        } catch (e) {
          setChatNotice('新建会话失败：' + String(e.message || e) + '（已复制提示词，可手动新建会话粘贴）')
          try { navigator.clipboard.writeText(NEW_OPP_PROMPT) } catch { /* ignore */ }
        }
      }

      const tabBtn = (id, label) => h('button', {
        key: id, className: 'presales-tab', type: 'button', role: 'tab', 'aria-selected': tab === id,
        onClick: () => setTab(id),
      }, label)

      if (tab === 'opp') {
        return h('div', { className: 'presales-panel' },
          h('header', { className: 'presales-head' },
            h('div', null,
              h('div', { className: 'presales-title' }, '商机管理'),
              h('div', { className: 'presales-sub' }, '阶段推进 · 跟进记录 · 变更留痕 · 关联报价与产物')),
            h('div', { className: 'presales-row' },
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void newOppChat() }, '新建商机（对话）'),
              h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
          h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('opp', '商机'), tabBtn('quote', '报价')),
          chatNotice ? h('div', { className: 'presales-msg ok' }, chatNotice) : null,
          h(OppTab, { onQuote: () => setTab('quote') }))
      }

      return h('div', { className: 'presales-panel' },
        h('header', { className: 'presales-head' }, 
          h('div', null,
            h('div', { className: 'presales-title' }, '报价工作台'),
            h('div', { className: 'presales-sub' }, '产品来自 WPS 产品清单；保存后写入报价管理（报价单 + V1 + 明细）')),
          h('div', { className: 'presales-row' },
            h('button', { className: 'presales-btn', type: 'button', onClick: () => void load() }, '刷新'))),
        h('div', { className: 'presales-tabs', role: 'tablist' }, tabBtn('opp', '商机'), tabBtn('quote', '报价')),
        status ? h('div', { className: 'presales-card presales-row' },
          h('span', { className: `presales-badge ${status.ok ? 'ok' : 'err'}` }, status.ok ? 'WPS 已连接' : '未连接'),
          h('span', { className: 'presales-muted' }, `产品 ${status.counts?.products ?? '-'} · 客户 ${status.counts?.customers ?? '-'} · 报价 ${status.counts?.quotes ?? '-'}`)) : null,
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
        cart.length ? h('section', { className: 'presales-card' },
          h('table', { className: 'presales-table' },
            h('thead', null, h('tr', null,
              ['产品', '单位', '未税单价', '数量', '折扣', '含税小计', ''].map((t) => h('th', { key: t }, t)))),
            h('tbody', null, cart.map((l) => {
              const unit = round(l.stdPrice * l.discount, 4)
              const gross = round(round(unit * l.qty, 2) * (1 + l.taxRate), 2)
              return h('tr', { key: l.code },
                h('td', null, l.name, h('div', { className: 'presales-muted' }, l.code)),
                h('td', null, l.unit),
                h('td', null, money(l.stdPrice)),
                h('td', null, h('input', { type: 'number', min: 0, value: l.qty, onChange: (e) => patch(l.code, 'qty', Number(e.target.value)) })),
                h('td', null, h('input', { type: 'number', min: 0.01, max: 1, step: 0.01, value: l.discount, onChange: (e) => patch(l.code, 'discount', Number(e.target.value)) })),
                h('td', null, money(gross)),
                h('td', null, h('button', { className: 'presales-btn', type: 'button', onClick: () => remove(l.code) }, '移除')))
            }))),
          h('div', { className: 'presales-total', style: { marginTop: 12 } },
            h('span', null, '未税 ', h('b', null, money(totals.untaxed))),
            h('span', null, '税额 ', h('b', null, money(totals.tax))),
            h('span', null, '含税 ', h('b', null, money(totals.gross))),
            h('span', null, '毛利率 ', h('b', null, totals.margin == null ? '-' : (totals.margin * 100).toFixed(2) + '%'))),
          h('div', { className: 'presales-row', style: { marginTop: 12 } },
            h('button', { className: 'presales-btn primary', type: 'button', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '生成报价单'))) : null,
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
            h('span', null, q.link ? h('a', { href: q.link, target: '_blank', rel: 'noreferrer', style: { marginRight: 10 } }, '打开') : null, `含税 ${money(q.grossTotal)}`)))) : h('div', { className: 'presales-muted' }, '暂无')), renderUpdateCard())
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
