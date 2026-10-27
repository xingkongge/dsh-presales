/** 业务表别名 → WPS 多维表 file_id/sheet_id（默认值来自 09-表ID清单）。 */
export const DEFAULT_TABLES = {
  customers: { fileId: 'MPV2Yep7UxMhS89GmLmRxxXGbzzL1xtDu', sheetId: 3, label: '客户' },
  opportunities: { fileId: 'zGb3sHAVMrMCH9CCuUborxRzw3AMLEgqU', sheetId: 3, label: '商机' },
  oppFollowups: { fileId: 'zGb3sHAVMrMCH9CCuUborxRzw3AMLEgqU', sheetId: 4, label: '商机跟进记录' },
  oppChanges: { fileId: 'zGb3sHAVMrMCH9CCuUborxRzw3AMLEgqU', sheetId: 5, label: '商机变更记录' },
  products: { fileId: 'bHGthCBzrxM7zrUdHetQrxAQWHyQTQCtV', sheetId: 3, label: '产品清单' },
  productModules: { fileId: 'bHGthCBzrxM7zrUdHetQrxAQWHyQTQCtV', sheetId: 4, label: '产品模块' },
  productCategories: { fileId: 'bHGthCBzrxM7zrUdHetQrxAQWHyQTQCtV', sheetId: 7, label: '产品分类' },
  quotes: { fileId: 'rRKWZzuh11MmFLv4N4amxxnBkg16nEDXe', sheetId: 3, label: '报价单' },
  quoteVersions: { fileId: 'rRKWZzuh11MmFLv4N4amxxnBkg16nEDXe', sheetId: 4, label: '报价版本' },
  quoteItems: { fileId: 'rRKWZzuh11MmFLv4N4amxxnBkg16nEDXe', sheetId: 5, label: '报价明细' },
  documents: { fileId: 'MdFpdHoTtxMeS1NGfZitxxMk6x3UTdMJe', sheetId: 3, label: '文档产物' },
  quoteTemplates: { fileId: '85stiqQVi1MxUXpaJoY5rxAc1VEKiC8bU', sheetId: 3, label: '报价模板' },
}

export function resolveTables(config = {}) {
  const override = config.tables && typeof config.tables === 'object' ? config.tables : {}
  const out = {}
  for (const [alias, def] of Object.entries(DEFAULT_TABLES)) {
    out[alias] = { ...def, ...(override[alias] || {}) }
  }
  return out
}
