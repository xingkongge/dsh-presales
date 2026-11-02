import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildRfqMail,
  formatDate,
  formatMoney,
  formatRecipients,
  parseRecipients,
} from '../lib/rfq-mail.js'

const rfq = {
  no: 'RFQ-2026-0003',
  productName: '信创服务器',
  spec: '2U，2×鲲鹏920，128GB',
  brand: '华为',
  model: 'TaiShan 2280',
  unit: '台',
  qty: 2,
  targetPrice: 120000,
  replyBy: '2026-11-10',
  note: '含 3 年原厂质保',
}

const opportunity = {
  no: 'OPP-2026-0012',
  name: '中国建材水泥-信创改造',
  customerName: '中国建材水泥',
  stage: '方案报价',
  expected: '2026-12-05',
}

const sender = {
  name: '张三',
  title: '售前解决方案经理',
  phone: '13800000000',
  email: 'zhangsan@example.com',
  company: '中建材信息技术',
}

describe('buildRfqMail：主题与必含信息', () => {
  it('主题含客户、产品与询价单号；正文含商机/规格/数量/目标价/回复截止/联系人', () => {
    const mail = buildRfqMail({ rfq, opportunity, sender, recipients: 'vendor@example.com' })

    assert.equal(mail.subject, '【询价】中国建材水泥 信创服务器（RFQ-2026-0003）')

    for (const must of [
      'OPP-2026-0012', // 商机
      '中国建材水泥-信创改造',
      '方案报价',
      'RFQ-2026-0003', // 询价单号
      '2U，2×鲲鹏920，128GB', // 规格
      '数量：2', // 数量
      '¥120,000', // 目标价
      '2026-11-10', // 回复截止
      '张三', // 联系人
      '13800000000',
      'zhangsan@example.com',
      '含 3 年原厂质保', // 备注
    ]) {
      assert.ok(mail.text.includes(must), `纯文本缺少：${must}`)
    }

    // 三段式结构齐全，且不带发件人/收件人头
    assert.ok(mail.text.startsWith('您好：'))
    assert.ok(mail.text.includes('一、询价清单'))
    assert.ok(mail.text.includes('二、报价要求'))
    assert.ok(mail.text.includes('三、回复截止'))
    assert.ok(mail.text.includes('四、联系人'))
    assert.ok(!mail.text.includes('vendor@example.com'))
    assert.ok(mail.text.endsWith('\n'))
    // 全单备注只出现一次（结尾备注段），不在明细行重复
    assert.equal(mail.text.split('含 3 年原厂质保').length - 1, 1)
  })

  it('HTML 与纯文本信息同源，并转义用户输入', () => {
    const mail = buildRfqMail({
      rfq: { ...rfq, productName: '服务器<script>alert(1)</script>', note: 'A&B "报价"' },
      opportunity,
      sender,
    })
    assert.ok(mail.html.includes('&lt;script&gt;'), 'HTML 未转义尖括号')
    assert.ok(mail.html.includes('A&amp;B &quot;报价&quot;'), 'HTML 未转义 & 与引号')
    assert.ok(!mail.html.includes('<script>'))
    // 关键业务信息在两个版本里都能找到
    assert.ok(mail.html.includes('RFQ-2026-0003'))
    assert.ok(mail.html.includes('¥120,000'))
    assert.ok(mail.text.includes('¥120,000'))
  })
})

describe('buildRfqMail：多行与缺省', () => {
  it('多行 items：逐行渲染，主题标出「等 N 项」', () => {
    const mail = buildRfqMail({
      rfq: {
        no: 'RFQ-2026-0004',
        replyBy: '2026-11-12',
        items: [
          { productName: '信创服务器', spec: '2U', qty: 2, unit: '台', targetPrice: 120000 },
          { productName: '万兆交换机', model: 'S5735', qty: 4, unit: '台' },
        ],
      },
      opportunity,
      sender,
    })
    assert.equal(mail.subject, '【询价】中国建材水泥 信创服务器 等 2 项（RFQ-2026-0004）')
    assert.ok(mail.text.includes('1. 信创服务器｜规格：2U｜单位：台｜数量：2｜目标价（含税）：¥120,000'))
    assert.ok(mail.text.includes('2. 万兆交换机｜型号：S5735｜单位：台｜数量：4'))
    assert.equal((mail.html.match(/<li style="margin:0 0 6px">/g) || []).length >= 2, true)
  })

  it('缺商机/联系人/目标价/截止日时不抛错，给出兜底文案', () => {
    const mail = buildRfqMail({ rfq: { no: 'RFQ-2026-0005', productName: 'KVM 切换器', qty: 1 } })
    assert.equal(mail.subject, '【询价】KVM 切换器（RFQ-2026-0005）')
    assert.ok(!mail.text.includes('【商机】'))
    assert.ok(!mail.text.includes('四、联系人'))
    assert.ok(mail.text.includes('目标价：暂无，请给最优价'))
    assert.ok(mail.text.includes('请于 3 个工作日内回复本邮件'))
    assert.ok(mail.html.startsWith('<div style='))
    assert.ok(mail.html.endsWith('</div>'))
  })

  it('空入参也不炸，主题退化为「产品询价」', () => {
    const mail = buildRfqMail()
    assert.equal(mail.subject, '【询价】产品询价')
    assert.ok(mail.text.length > 0)
    assert.ok(mail.html.length > 0)
  })

  it('recipients 给了但一个都不合法时早失败；合法时不进正文', () => {
    const ok = buildRfqMail({ rfq, opportunity, sender, recipients: '采购 <buyer@example.com>; bad@@x' })
    assert.ok(!ok.text.includes('buyer@example.com'), '收件人不该写进正文')
    assert.throws(
      () => buildRfqMail({ rfq, opportunity, sender, recipients: 'bad@@x' }),
      /收件人无法解析：bad@@x（bad-email）/,
    )
  })
})

describe('parseRecipients：分隔符与显示名', () => {
  it('识别逗号/分号/顿号/换行分隔与显示名，拼回 to 字符串', () => {
    const { valid, invalid } = parseRecipients(
      '张三 <zhang@example.com>;,li@example.com、wang@example.com\n"李 四" <li4@example.com>',
    )
    assert.deepEqual(invalid, [])
    assert.deepEqual(valid, [
      { name: '张三', email: 'zhang@example.com' },
      { name: null, email: 'li@example.com' },
      { name: null, email: 'wang@example.com' },
      { name: '李 四', email: 'li4@example.com' },
    ])
    assert.equal(
      formatRecipients(valid),
      '张三 <zhang@example.com>, li@example.com, wang@example.com, 李 四 <li4@example.com>',
    )
  })

  it('数组入参、重复地址（大小写不敏感）与非法项', () => {
    const { valid, invalid } = parseRecipients([
      'a@example.com',
      'A@Example.com', // duplicate
      'no-at-sign', // bad-email
      '错 <bad>', // 邮箱本体不合格
      '坏 <bad', // 尖括号不配
      'ok@example.com extra', // 邮箱中间有空格
      '',
    ])
    assert.deepEqual(valid, [{ name: null, email: 'a@example.com' }])
    assert.deepEqual(invalid.map((x) => x.reason), [
      'duplicate',
      'bad-email',
      'bad-email',
      'bad-format',
      'bad-email',
    ])
    // 空串与纯空白不产生噪音
    assert.equal(parseRecipients('  ,  ;  ').valid.length, 0)
    assert.equal(parseRecipients('  ,  ;  ').invalid.length, 0)
    assert.deepEqual(parseRecipients(null), { valid: [], invalid: [] })
  })
})

describe('格式化小工具', () => {
  it('金额千分位', () => {
    assert.equal(formatMoney(120000), '120,000')
    assert.equal(formatMoney('98.5'), '98.50')
    assert.equal(formatMoney(0), '0')
    assert.equal(formatMoney('abc'), '')
  })

  it('日期归一与非法输入透传', () => {
    assert.equal(formatDate('2026-11-10T00:00:00.000Z'), '2026-11-10')
    assert.equal(formatDate('2026/11/10'), '2026-11-10')
    assert.equal(formatDate('下周五'), '下周五')
    assert.equal(formatDate(''), '')
  })
})
