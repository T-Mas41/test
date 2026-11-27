/* 業務ロジック: 売上・販売台帳・受領レイアウトの取込、商品コード変換、照合、確認状況、レポート、バックアップ */
(function (RM) {
  'use strict';
  const { text, code, isBlank, number, toAmount, toMilli, date, fmtDate, ReadError } = RM;
  const now = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  RM.now = now;
  const cell = (row, col) => (row ? row[col] : undefined);

  // ================================================================ 売上(固定レイアウト・188列、列は位置で特定)
  // 自社商品コードは「商品識別コード」(9桁・50列目)を使う
  RM.SALES_COLS = { cust: 7, cust_name: 8, store: 81, store_name: 82, tdate: 137, order_no: 35, own_code: 50, name: 10, qty: 33, wt: 32, amt: 58, slip_no: 18 };

  function checkHeaders(header, cols, expected, label) {
    const errs = [];
    for (const col of Object.values(cols)) {
      const a = text(cell(header, col));
      if (a !== expected[col - 1]) errs.push(`${col}列目の見出しが「${a || '(空欄)'}」です(想定:「${expected[col - 1]}」)`);
    }
    if (errs.length) throw new ReadError(`${label}のレイアウトが想定と異なります。` + errs.slice(0, 5).join(' / '));
  }

  const hasAny = r => !!r.any || r.some(v => !isBlank(v));
  // 自社商品コード(商品識別コード)は9桁。Excelで数値になり先頭ゼロが落ちた場合は補う
  const ownCode = v => { const s = text(v).normalize('NFKC').trim(); return /^\d{1,8}$/.test(s) ? s.padStart(9, '0') : s; };
  RM.ownCode = ownCode;
  RM.hasAny = hasAny;

  /** 売上データを読む。販売先はデータ内の販売先コードで判定し、複数あればエラー。 */
  async function parseSales(buf, dfrom, dto, onProgress) {
    const rows = await RM.readXlsx(buf, { onProgress, cols: Object.values(RM.SALES_COLS) });
    if (!rows.length) throw new ReadError('売上データが空です。');
    checkHeaders(rows[0], RM.SALES_COLS, RM.SALES_HEADERS, '売上データ');
    const C = RM.SALES_COLS;
    const isKeyBlank = r => isBlank(cell(r, C.tdate)) && isBlank(cell(r, C.order_no)) && isBlank(cell(r, C.own_code));
    const custs = new Map();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (isKeyBlank(r)) continue;
      const c = code(cell(r, C.cust));
      if (!custs.has(c)) custs.set(c, { n: 0, name: text(cell(r, C.cust_name)) });
      custs.get(c).n++;
    }
    if (!custs.size) throw new ReadError('売上データにデータ行がありません。');
    if (custs.size > 1) {
      throw new ReadError('売上データに複数の販売先コードが含まれています(' +
        [...custs.entries()].map(([c, v]) => `${c || '(空欄)'}${v.name ? ' ' + v.name : ''}:${v.n.toLocaleString()}行`).join('、') +
        ')。販売先ごとに分けた売上データを取り込んでください。');
    }
    const [cust, info] = [...custs.entries()][0];
    if (!cust) throw new ReadError('売上データの販売先コード(7列目)が空欄です。');
    const lines = [], errors = [];
    const stats = { total: 0, target: 0, skipped_blank: 0, other_cust: 0, out_of_period: 0, error: 0 };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], g = k => cell(r, C[k]);
      if (isKeyBlank(r)) { if (hasAny(r)) stats.skipped_blank++; continue; }
      stats.total++;
      let td, q, w, a;
      try { td = date(g('tdate')); q = number(g('qty')); w = number(g('wt')); a = number(g('amt')); }
      catch (e) { stats.error++; errors.push({ file: '売上', row: i + 1, msg: e.message }); continue; }
      if (td < dfrom || td > dto) { stats.out_of_period++; continue; }
      lines.push({ row_no: i + 1, store: code(g('store')), store_name: text(g('store_name')), tdate: td, order_no: code(g('order_no')),
        slip_no: text(g('slip_no')), own_code: ownCode(g('own_code')), name: text(g('name')), qty: toMilli(q), wt: toMilli(w), amt: toAmount(a) });
    }
    stats.target = lines.length;
    return { lines, errors, stats, cust, custName: info.name };
  }

  // ================================================================ 販売台帳
  RM.LEDGER_COLS = { deleted: 1, own_code: 57, own_name: 60, partner_code: 72, cust: 111, cust_name: 112, store: 113, store_name: 114 };
  RM.STORE_ANY = '99999999999';

  RM.importLedger = importLedger;
  async function importLedger(buf, fileName, onProgress) {
    const rows = await RM.readXlsx(buf, { onProgress, cols: Object.values(RM.LEDGER_COLS) });
    if (!rows.length) throw new ReadError('販売台帳が空です。');
    checkHeaders(rows[0], RM.LEDGER_COLS, RM.LEDGER_HEADERS, '販売台帳');
    const C = RM.LEDGER_COLS, recs = [];
    let total = 0, deleted = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!hasAny(r)) continue;
      total++;
      const g = k => cell(r, C[k]);
      if (text(g('deleted')) === '9') { deleted++; continue; }
      const pc = code(g('partner_code')), oc = ownCode(g('own_code'));
      if (!pc || !oc) { skipped++; continue; }
      recs.push([code(g('cust')), text(g('cust_name')), code(g('store')) || RM.STORE_ANY, pc, oc, text(g('own_name')), text(g('store_name'))]);
    }
    const meta = { file_name: fileName, imported_at: now(), total_rows: total, loaded_rows: recs.length, deleted_rows: deleted, skipped_rows: skipped };
    await RM.db.put('kv', { k: 'ledger', meta, rows: recs });
    RM._storeNames = null;
    return meta;
  }
  async function ledger() { return (await RM.db.get('kv', 'ledger')) || { meta: null, rows: [] }; }
  RM.ledgerRows = async () => (await ledger()).rows.map(r => ({ cust: r[0], cust_name: r[1], store: r[2], partner_code: r[3], own_code: r[4], own_name: r[5] }));
  RM.ledgerMeta = async () => (await ledger()).meta;
  // 店舗コード → 店舗名(販売台帳の店舗略称)。売上・受領データに店舗名がない場合の補完用
  async function storeNames(cust) {
    if (RM._storeNames && RM._storeNames.cust === cust) return RM._storeNames.map;
    const map = new Map();
    for (const r of (await ledger()).rows) if (r[0] === cust && r[2] !== RM.STORE_ANY && r[6] && !map.has(r[2])) map.set(r[2], r[6]);
    RM._storeNames = { cust, map };
    return map;
  }
  RM.ledgerCustomers = async () => {
    const m = new Map();
    for (const r of (await ledger()).rows) if (!m.has(r[0]) || (!m.get(r[0]) && r[1])) m.set(r[0], r[1]);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };
  RM.ledgerDupKeys = rows => {
    const m = new Map();
    for (const r of rows) { const k = r.cust + '|' + r.store + '|' + r.partner_code; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(r.own_code); }
    return m;
  };

  class Converter {
    constructor(rows, cust) {
      this.map = new Map();
      const ck = code(cust);
      for (const r of rows) {
        if (r[0] !== ck) continue;
        const k = r[2] + '|' + r[3];
        if (!this.map.has(k)) this.map.set(k, []);
        this.map.get(k).push([r[4], r[5]]);
      }
    }
    convert(store, pcode) {
      let hits = store ? this.map.get(store + '|' + pcode) : null, via = '店舗一致';
      if (!hits) { hits = this.map.get(RM.STORE_ANY + '|' + pcode); via = '店舗指定なし'; }
      if (!hits) return ['[未変換]' + pcode, '', 'none', '販売台帳に登録がありません'];
      const [own, name] = hits[0];
      if (new Set(hits.map(h => h[0])).size > 1) return [own, name, 'multi', `候補${hits.length}件の先頭を採用(${via}): ` + hits.slice(0, 5).map(h => h[0]).join('、')];
      return [own, name, 'ok', via];
    }
  }

  // ================================================================ 受領レイアウト
  RM.ROLES = [
    ['tdate', '取引日付', true], ['order_no', '相手先注文番号', true], ['partner_code', '相手先商品コード', true], ['amt', '金額', true],
    ['qty', '数量', false], ['wt', '重量', false], ['store', '店舗コード', false], ['store_name', '店舗名', false],
    ['cust', '販売先コード', false], ['name', '商品名', false], ['unit_price', '単価', false],
  ];
  RM.ROLE_LABEL = Object.fromEntries(RM.ROLES.map(r => [r[0], r[1]]));
  RM.REQUIRED = RM.ROLES.filter(r => r[2]).map(r => r[0]);
  const SUGGEST = {
    '取引日付': 'tdate', '計上日': 'tdate', '相手先注文番号': 'order_no', '取引番号（発注・返品）': 'order_no',
    '相手先商品コード': 'partner_code', '販売先商品識別ｺｰﾄﾞ': 'partner_code', '受領金額': 'amt', '原価金額': 'amt',
    '受領数量(総バラ)': 'qty', '受領数量（バラ）': 'qty', '受領重量': 'wt', '店舗コード': 'store', '店舗略称': 'store_name',
    '販売先コード': 'cust', '相手先商品名カナ': 'name', '商品名': 'name', '受領単価': 'unit_price', '原単価': 'unit_price',
  };
  // 見出し名の言い回しから役割を推測(完全一致で決まらない列に使う。上から順に優先)
  const SUGGEST_RE = [
    ['tdate', /(取引|納品|計上|伝票|受領|検収|出荷)?(日付|日)$|年月日/],
    ['order_no', /(注文|発注|伝票|取引)(番号|No|NO|№|ＮＯ)/],
    ['partner_code', /JAN|ＪＡＮ|GTIN|品番|(相手先|得意先|取引先)?商品(コード|CD|ｺｰﾄﾞ)/],
    ['amt', /^(?!.*単価).*(金額|価額)/],
    ['qty', /数量|個数|ケース数|バラ数/],
    ['wt', /重量|重さ|kg|ＫＧ/i],
    ['store_name', /(店舗|店|納品先)(名|名称|略称)/],
    ['store', /(店舗|店|納品先)(コード|CD|番号|No)/],
    ['name', /(商品|品)(名|名称)|品名/],
    ['unit_price', /単価/],
  ];
  function suggestRoles(header) {
    const used = new Set(), map = {};
    header.forEach((h, i) => { const r = SUGGEST[h]; if (r && !used.has(r)) { map[i + 1] = r; used.add(r); } });
    // 取引日付は、受領データで使われやすい日付を優先(発注日は最後)
    if (!used.has('tdate')) {
      const pri = ['検収', '計上', '納品', '取引', '受領', '出荷', '伝票', ''];
      const cands = header.map((h, j) => [h, j]).filter(([h, j]) => h && !map[j + 1] && /(日付|日)$|年月日/.test(h) && !/曜日/.test(h));
      const score = h => { const k = pri.findIndex(p => p && h.includes(p)); return k >= 0 ? k : (/発注/.test(h) ? 99 : pri.length); };
      cands.sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]);
      if (cands.length) { map[cands[0][1] + 1] = 'tdate'; used.add('tdate'); }
    }
    for (const [role, re] of SUGGEST_RE) {
      if (used.has(role) || role === 'tdate') continue;
      const i = header.findIndex((h, j) => !map[j + 1] && h && re.test(h));
      if (i >= 0) { map[i + 1] = role; used.add(role); }
    }
    return map;
  }
  RM.suggestRoles = suggestRoles;
  RM.STANDARD_MAP = { 2: 'tdate', 3: 'store', 4: 'store_name', 5: 'order_no', 7: 'unit_price', 8: 'amt', 11: 'cust', 14: 'partner_code', 15: 'name', 21: 'qty', 22: 'wt' };
  RM.BMS_MAP = { 71: 'tdate', 29: 'store', 31: 'store_name', 22: 'order_no', 113: 'partner_code', 117: 'name', 146: 'unit_price', 147: 'amt', 163: 'qty', 165: 'wt' };

  function newLayout(name, std, file_type, encoding, delimiter, sheet_name, header_row, data_start_row, headers, mapping) {
    return { name, is_standard: std, file_type, encoding, delimiter, sheet_name, header_row, data_start_row, updated_at: now(),
      sample_file: '', sample_rows: [], columns: headers.map((h, i) => ({ col_no: i + 1, header: h, role: mapping[i + 1] || '', date_format: '' })) };
  }
  RM.seed = async () => {
    if ((await RM.db.all('layouts')).length) return;
    await RM.db.put('layouts', newLayout('標準レイアウト', true, 'excel', 'cp932', ',', '', 1, 2, RM.STANDARD_RECEIPT_HEADERS, RM.STANDARD_MAP));
    await RM.db.put('layouts', newLayout('流通BMS 受領CSV', false, 'csv', 'cp932', ',', '', 1, 2, RM.BMS_RECEIPT_HEADERS, RM.BMS_MAP));
  };
  RM.layouts = async () => (await RM.db.all('layouts')).sort((a, b) => (b.is_standard - a.is_standard) || (a.id - b.id));
  RM.assignments = async () => (await RM.db.all('assignments')).sort((a, b) => (a.cust < b.cust ? -1 : 1));
  RM.layoutFor = async cust => {
    const a = await RM.db.get('assignments', code(cust));
    if (a) { const l = await RM.db.get('layouts', a.layout_id); if (l) return [l, true]; }
    return [(await RM.db.all('layouts')).find(l => l.is_standard) || null, false];
  };

  async function readSample(buf, lay) {
    const rows = await RM.readRows(buf, lay.file_type, { encoding: lay.encoding, delimiter: lay.delimiter, sheetName: lay.sheet_name, maxRow: lay.data_start_row + 4 });
    if (rows.length < lay.header_row) throw new ReadError(`見出し行(${lay.header_row}行目)がありません。`);
    const hr = rows[lay.header_row - 1];
    const header = [];
    for (let c = 1; c < hr.length; c++) header.push(text(hr[c]));
    while (header.length && header[header.length - 1] === '') header.pop();
    if (!header.length) throw new ReadError(`${lay.header_row}行目に見出しがありません。`);
    const samples = rows.slice(lay.data_start_row - 1, lay.data_start_row + 4).map(r => header.map((_, i) => text(cell(r, i + 1))));
    return { header, samples };
  }
  RM.createLayoutFromSample = async (settings, fileName, buf) => {
    const { header, samples } = await readSample(buf, settings);
    const map = suggestRoles(header);
    const lay = newLayout(settings.name, false, settings.file_type, settings.encoding, settings.delimiter, settings.sheet_name, settings.header_row, settings.data_start_row, header, map);
    lay.sample_file = fileName; lay.sample_rows = samples;
    return RM.db.put('layouts', lay);
  };
  RM.reloadSample = async (id, fileName, buf) => {
    const lay = await RM.db.get('layouts', id);
    const { header, samples } = await readSample(buf, lay);
    const old = new Map(lay.columns.map(c => [c.col_no + '|' + c.header, c]));
    lay.columns = header.map((h, i) => { const o = old.get((i + 1) + '|' + h); return { col_no: i + 1, header: h, role: o ? o.role : '', date_format: o ? o.date_format : '' }; });
    lay.sample_file = fileName; lay.sample_rows = samples; lay.updated_at = now();
    await RM.db.put('layouts', lay);
  };
  RM.validateRoles = cols => {
    const used = cols.map(c => c.role).filter(Boolean), errs = [];
    for (const k of RM.REQUIRED) if (!used.includes(k)) errs.push(`必須の役割「${RM.ROLE_LABEL[k]}」が設定されていません`);
    for (const k of [...new Set(used)]) if (used.filter(u => u === k).length > 1) errs.push(`役割「${RM.ROLE_LABEL[k]}」が複数の列に設定されています`);
    return errs;
  };
  RM.saveLayout = async (id, settings, roles, fmts) => {
    const lay = await RM.db.get('layouts', id);
    const cols = lay.columns.map(c => ({ ...c, role: roles[c.col_no] !== undefined ? roles[c.col_no] : c.role }));
    cols.forEach(c => { c.date_format = c.role === 'tdate' ? (fmts[c.col_no] !== undefined ? fmts[c.col_no] : c.date_format) : ''; });
    const errs = RM.validateRoles(cols);
    if (!(settings.header_row >= 1) || !(settings.data_start_row > settings.header_row)) errs.push('データ開始行は見出し行より後ろにしてください');
    if (!settings.name.trim()) errs.push('レイアウト名を入力してください');
    if (errs.length) return errs;
    Object.assign(lay, settings, { name: settings.name.trim(), sheet_name: settings.sheet_name.trim(), columns: cols, updated_at: now() });
    await RM.db.put('layouts', lay);
    return [];
  };
  RM.setStandard = async id => { for (const l of await RM.db.all('layouts')) { l.is_standard = l.id === id; await RM.db.put('layouts', l); } };
  RM.deleteLayout = async id => {
    const l = await RM.db.get('layouts', id);
    if (!l) return 'レイアウトが見つかりません';
    if (l.is_standard) return '標準レイアウトは削除できません(先に別のレイアウトを標準にしてください)';
    if ((await RM.db.all('assignments')).some(a => a.layout_id === id)) return '得意先に割り当てられているため削除できません(先に割当を解除してください)';
    await RM.db.del('layouts', id);
    return null;
  };
  RM.assign = async (cust, custName, layoutId) => {
    let name = custName.trim();
    if (!name) name = ((await RM.ledgerCustomers()).find(c => c[0] === code(cust)) || [, ''])[1] || '';
    await RM.db.put('assignments', { cust: code(cust), cust_name: name, layout_id: layoutId });
  };
  RM.unassign = cust => RM.db.del('assignments', cust);

  RM.previewLayout = lay => lay.sample_rows.map(s => {
    const rec = {};
    for (const c of lay.columns) {
      if (!c.role) continue;
      const raw = s[c.col_no - 1] || '';
      try {
        if (c.role === 'tdate') rec.tdate = fmtDate(date(raw, c.date_format));
        else if (c.role === 'amt') rec.amt = RM.fAmt(toAmount(number(raw)));
        else if (c.role === 'qty' || c.role === 'wt') rec[c.role] = RM.fWt(toMilli(number(raw)));
        else if (['order_no', 'partner_code', 'store', 'cust'].includes(c.role)) rec[c.role] = code(raw);
        else rec[c.role] = raw;
      } catch (e) { rec[c.role] = '⚠ ' + e.message; }
    }
    return rec;
  });

  async function parseReceipt(lay, buf, cust, dfrom, dto, conv, onProgress) {
    const cols = {};
    for (const c of lay.columns) if (c.role) cols[c.role] = c;
    const missing = RM.REQUIRED.filter(k => !cols[k]).map(k => RM.ROLE_LABEL[k]);
    if (missing.length) throw new ReadError(`レイアウト「${lay.name}」に必須の役割がありません: ${missing.join('、')}`);
    const rows = await RM.readRows(buf, lay.file_type, { encoding: lay.encoding, delimiter: lay.delimiter, sheetName: lay.sheet_name, onProgress,
      cols: Object.values(cols).map(c => c.col_no) });
    const ck = code(cust), lines = [], errors = [];
    const stats = { total: 0, target: 0, skipped_blank: 0, other_cust: 0, out_of_period: 0, error: 0, conv_none: 0, conv_multi: 0 };
    for (let i = lay.data_start_row - 1; i < rows.length; i++) {
      const r = rows[i], g = k => (cols[k] ? cell(r, cols[k].col_no) : undefined);
      if (isBlank(g('tdate')) && isBlank(g('order_no')) && isBlank(g('partner_code'))) {
        if (hasAny(r)) stats.skipped_blank++;
        continue;
      }
      stats.total++;
      if (cols.cust && !isBlank(g('cust')) && code(g('cust')) !== ck) { stats.other_cust++; continue; }
      let td, q, w, a;
      try { td = date(g('tdate'), cols.tdate.date_format); q = number(g('qty')); w = number(g('wt')); a = number(g('amt')); }
      catch (e) { stats.error++; errors.push({ file: '受領', row: i + 1, msg: e.message }); continue; }
      if (td < dfrom || td > dto) { stats.out_of_period++; continue; }
      const store = code(g('store')), pc = code(g('partner_code'));
      const [own, ownName, st, note] = conv.convert(store, pc);
      if (st === 'none') stats.conv_none++; else if (st === 'multi') stats.conv_multi++;
      lines.push({ row_no: i + 1, store, store_name: text(g('store_name')), tdate: td, order_no: code(g('order_no')), partner_code: pc,
        own_code: own, name: text(g('name')), own_name: ownName, qty: toMilli(q), wt: toMilli(w), unit_price: text(g('unit_price')),
        amt: toAmount(a), conv_status: st, conv_note: note });
    }
    stats.target = lines.length;
    return { lines, errors, stats };
  }

  // ================================================================ 照合
  // full: 数量・重量も比較・表示する(日別商品別のみ)。それ以外は金額のみ
  RM.VIEWS = {
    day: { label: '日別', keys: ['tdate'], heads: ['取引日付'], full: false },
    store: { label: '日別店別', keys: ['tdate', 'store'], heads: ['取引日付', '店舗コード', '店舗名'], full: false },
    slip: { label: '伝票番号別', keys: ['order_no'], heads: ['相手先注文番号', '取引日付', '店舗コード', '店舗名'], full: false },
    dsi: { label: '日別伝票商品別', keys: ['tdate', 'order_no', 'own_code'], heads: ['取引日付', '相手先注文番号', '店舗コード', '店舗名', '自社商品コード', '商品名'], full: true },
    item: { label: '日別商品別', keys: ['tdate', 'own_code'], heads: ['取引日付', '自社商品コード', '商品名'], full: true },
  };
  for (const v of Object.values(RM.VIEWS)) v.k1 = v.heads[0];
  RM.JUDGE = { ok: ['一致', 'b-ok', ''], diff: ['差異あり', 'b-diff', 'r-diff'], sonly: ['自社のみ', 'b-s', 'r-s'], ronly: ['受領のみ', 'b-r', 'r-r'] };
  const MAX_ERRORS = 500;

  /** ファイルを読み込み、下書き(未保存)を返す。確定は confirm。 */
  RM.stage = async ({ dateFrom, dateTo, salesName, salesBuf, receiptName, receiptBuf, parentId, onProgress }) => {
    if (dateFrom > dateTo) throw new ReadError('期間の From が To より後になっています。');
    onProgress && onProgress('売上データを読み込んでいます…');
    const s = await parseSales(salesBuf, dateFrom, dateTo, n => onProgress && onProgress(`売上データを読み込んでいます…(${n.toLocaleString()}行)`));
    const cust = s.cust;
    if (parentId) {
      const p = await RM.db.get('matches', parentId);
      if (p && p.cust !== cust) throw new ReadError(`売上データの販売先(${cust})が、再取込元の照合の販売先(${p.cust})と異なります。`);
    }
    const [lay, assigned] = await RM.layoutFor(cust);
    if (!lay) throw new ReadError('標準レイアウトが登録されていません。受領レイアウト画面で標準を指定してください。');
    const led = await ledger();
    const conv = new Converter(led.rows, cust);
    onProgress && onProgress('受領データを読み込んでいます…');
    const r = await parseReceipt(lay, receiptBuf, cust, dateFrom, dateTo, conv, n => onProgress && onProgress(`受領データを読み込んでいます…(${n.toLocaleString()}行)`));
    let custName = s.custName;
    if (!custName) custName = ((await RM.ledgerCustomers()).find(c => c[0] === cust) || [, ''])[1] || '';
    const errors = s.errors.concat(r.errors);
    return {
      parent_id: parentId || null, cust, cust_name: custName, date_from: dateFrom, date_to: dateTo,
      sales_file: salesName, receipt_file: receiptName, layout_name: lay.name, created_at: now(),
      stats: { sales: s.stats, receipt: r.stats, error_count: errors.length, layout_assigned: assigned, ledger_empty: !led.meta },
      errors: errors.slice(0, MAX_ERRORS), sales: s.lines, receipt: r.lines,
    };
  };

  RM.confirm = async draft => {
    const { sales, receipt, ...m } = draft;
    m.status = 'done';
    m.matched_at = now();
    let id;
    if (m.parent_id && await RM.db.get('matches', m.parent_id)) {
      id = m.parent_id;
      const p = await RM.db.get('matches', id);
      Object.assign(p, m, { id, parent_id: null });
      await RM.db.put('matches', p);
    } else {
      delete m.parent_id;
      id = await RM.db.put('matches', m);
    }
    await RM.db.put('lines', { id, sales, receipt });
    RM._cache = null;
    await RM.refreshSummary(id);
    return id;
  };

  RM.getMatch = id => RM.db.get('matches', id);
  RM.listMatches = async (f = {}) => {
    let ms = (await RM.db.all('matches')).filter(m => m.status === 'done');
    if (f.cust) ms = ms.filter(m => m.cust === code(f.cust));
    if (f.dateFrom) ms = ms.filter(m => m.date_to >= f.dateFrom);
    if (f.dateTo) ms = ms.filter(m => m.date_from <= f.dateTo);
    if (f.unchecked) ms = ms.filter(m => m.unchecked_rows > 0);
    return ms.sort((a, b) => ((b.matched_at || '') + String(b.id).padStart(9, '0')).localeCompare((a.matched_at || '') + String(a.id).padStart(9, '0')));
  };
  RM.deleteMatch = async id => { await RM.db.del('matches', id); await RM.db.del('lines', id); await RM.db.del('confs', id); RM._cache = null; };

  async function lines(id) {
    if (RM._cache && RM._cache.id === id) return RM._cache;
    const l = (await RM.db.get('lines', id)) || { id, sales: [], receipt: [] };
    RM._cache = l;
    return l;
  }
  RM.lines = lines;
  async function confs(id) { return ((await RM.db.get('confs', id)) || { id, items: {} }).items; }

  function side(ls, keys, filt, isReceipt) {
    const m = new Map();
    for (const x of ls) {
      if (filt && !Object.keys(filt).every(k => x[k] === filt[k])) continue;
      const kv = keys.map(k => x[k]);
      const key = kv.join('|');
      let a = m.get(key);
      if (!a) { a = { key: kv, a: 0, q: 0, w: 0, n: 0, sname: '', iname: '', dates: new Set(), stores: new Set() }; m.set(key, a); }
      a.a += x.amt; a.q += x.qty; a.w += x.wt; a.n++;
      if (x.store_name && (!a.sname || x.store_name > a.sname)) a.sname = x.store_name;
      const nm = isReceipt ? (x.own_name || x.name) : x.name;
      if (nm && (!a.iname || nm > a.iname)) a.iname = nm;
      a.dates.add(x.tdate); if (x.store) a.stores.add(x.store);
    }
    return m;
  }
  function compare(s, r, full = true) {
    const S = s ? [s.a, s.q, s.w] : [0, 0, 0], R = r ? [r.a, r.q, r.w] : [0, 0, 0];
    const d = [S[0] - R[0], S[1] - R[1], S[2] - R[2]];
    void full;  // 差異のあり・なしは、どの切り口でも金額だけで判定する(数量・重量は表示のみ)
    // 差異金額が0なら、片方にしか計上がなくても「一致」とする
    const judge = d[0] === 0 ? 'ok' : !s ? 'ronly' : !r ? 'sonly' : 'diff';
    const [label, badge, rowCls] = RM.JUDGE[judge];
    return { s: s ? S : null, r: r ? R : null, d, judge, judge_label: label,
      judge_short: label, badge, row_cls: rowCls, ok: judge === 'ok' };
  }
  RM.compare = compare;
  function aggregateKeys(l, keys, filt, full = true) {
    const sd = side(l.sales, keys, filt, false), rd = side(l.receipt, keys, filt, true);
    const all = [...new Set([...sd.keys(), ...rd.keys()])].sort();
    return all.map(k => { const s = sd.get(k), r = rd.get(k); return Object.assign(compare(s, r, full), { key: (s || r).key, key_str: k, srow: s, rrow: r }); });
  }
  const md = set => [...set].sort().map(fmtDate).join(',');

  RM.aggregate = async (id, view) => {
    const v = RM.VIEWS[view], l = await lines(id), cf = await confs(id);
    const m = await RM.db.get('matches', id), led = await storeNames(m ? m.cust : '');
    // 店舗名: 照合内の売上 → 受領 → 販売台帳 の順に、店舗コードごとに分かっている名前を使う
    const sn = new Map();
    for (const x of l.sales) if (x.store && x.store_name && !sn.has(x.store)) sn.set(x.store, x.store_name);
    for (const x of l.receipt) if (x.store && x.store_name && !sn.has(x.store)) sn.set(x.store, x.store_name);
    for (const [k, v] of led) if (!sn.has(k)) sn.set(k, v);
    const rows = aggregateKeys(l, v.keys, null, v.full);
    const short = (arr, all) => (arr.length > 3 ? `${arr.slice(0, 3).join('、')} …他${arr.length - 3}店` : all);
    for (const row of rows) {
      const k = row.key, s = row.srow, r = row.rrow;
      const stores = [...new Set([...(s ? s.stores : []), ...(r ? r.stores : [])])].sort();
      const dates = [...new Set([...(s ? s.dates : []), ...(r ? r.dates : [])])].sort();
      // 検索条件用(日付・店舗・注文番号)
      row.fdates = dates; row.fstores = stores; row.forder = view === 'slip' ? k[0] : view === 'dsi' ? k[1] : '';
      const sname = (view === 'store' ? sn.get(k[1]) : '') || (s && s.sname) || (r && r.sname) || '';
      const iname = (s && s.iname) || (r && r.iname) || '';
      const names = stores.map(x => sn.get(x) || '').filter(Boolean);
      const nm = names.join('、') || (s && s.sname) || (r && r.sname) || '';
      if (view === 'day') row.cells = [fmtDate(k[0])];
      else if (view === 'store') row.cells = [fmtDate(k[0]), k[1], sname];
      else if (view === 'item') row.cells = [fmtDate(k[0]), k[1], iname];
      else if (view === 'dsi') {
        row.cells = [fmtDate(k[0]), k[1] || '(注文番号なし)', short(stores, stores.join('、')), short(names, nm), k[2], iname];
        row.tips = ['', '', stores.length > 3 ? stores.join('、') : '', names.length > 3 ? nm : '', '', ''];
      } else {
        const sd = s ? md(s.dates) : '', rd = r ? md(r.dates) : '';
        const dtext = s && r && sd !== rd ? `売上 ${sd} / 受領 ${rd}` : (sd || rd);
        // 店舗が多い伝票は短く表示(全店舗は tips に入れ、画面ではマウスを乗せると表示)
        row.cells = [k[0] || '(注文番号なし)', dtext, short(stores, stores.join('、')), short(names, nm)];
        row.tips = ['', '', stores.length > 3 ? stores.join('、') : '', names.length > 3 ? nm : ''];
      }
      row.k1 = row.cells[0];
      row.k2 = row.cells.slice(1).filter(Boolean).join(' ・ ');
      const c = cf[view + '|' + row.key_str];
      row.checked = !!(c && c.checked); row.comment = c ? c.comment : ''; row.updated_at = c ? c.updated_at : '';
    }
    // 伝票番号別は 日付 → 注文番号 の順に並べる(日付は伝票内の最も早い日付)
    if (view === 'slip') rows.sort((a, b) => ((a.fdates[0] || '') + '|' + a.key[0]).localeCompare((b.fdates[0] || '') + '|' + b.key[0], 'ja', { numeric: true }));
    rows.storeNames = sn;
    return rows;
  };
  RM.totals = async id => {
    const l = await lines(id);
    const sum = ls => ls.length ? { a: ls.reduce((t, x) => t + x.amt, 0), q: ls.reduce((t, x) => t + x.qty, 0), w: ls.reduce((t, x) => t + x.wt, 0) } : null;
    const s = sum(l.sales), r = sum(l.receipt);
    const res = compare(s, r, false);  // 合計は金額で判定
    res.s = res.s || [0, 0, 0]; res.r = res.r || [0, 0, 0];
    res.s_rows = l.sales.length; res.r_rows = l.receipt.length;
    return res;
  };
  RM.warnings = async id => (await lines(id)).receipt.filter(x => x.conv_status !== 'ok')
    .sort((a, b) => (a.tdate + a.order_no + String(a.row_no).padStart(9, '0')).localeCompare(b.tdate + b.order_no + String(b.row_no).padStart(9, '0')));
  RM.counts = async id => {
    const l = await lines(id), out = {};
    for (const [k, v] of Object.entries(RM.VIEWS)) out[k] = aggregateKeys(l, v.keys, null, v.full).filter(r => !r.ok).length;
    out.warn = (await RM.warnings(id)).length;
    return out;
  };
  RM.refreshSummary = async id => {
    const m = await RM.db.get('matches', id);
    if (!m) return;
    const t = await RM.totals(id), diff = (await RM.aggregate(id, 'slip')).filter(r => !r.ok);
    Object.assign(m, { total_judge: t.judge, total_diff_amt: t.d[0], slip_diff_rows: diff.length, unchecked_rows: diff.filter(r => !r.checked).length });
    await RM.db.put('matches', m);
  };
  RM.keyFilter = (view, keyStr) => {
    const keys = RM.VIEWS[view].keys, vals = keyStr.split('|');
    if (vals.length !== keys.length) throw new Error('キーが不正です');
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  };
  RM.detail = async (id, view, keyStr) => {
    const filt = RM.keyFilter(view, keyStr), l = await lines(id);
    const row = (await RM.aggregate(id, view)).find(r => r.key_str === keyStr) || null;
    const match = x => Object.keys(filt).every(k => x[k] === filt[k]);
    const ord = (a, b) => (a.tdate + a.order_no + String(a.row_no).padStart(9, '0')).localeCompare(b.tdate + b.order_no + String(b.row_no).padStart(9, '0'));
    const products = aggregateKeys(l, ['own_code'], filt).map(p => Object.assign(p, { name: (p.srow && p.srow.iname) || (p.rrow && p.rrow.iname) || '' }));
    return { row, sales: l.sales.filter(match).sort(ord), receipt: l.receipt.filter(match).sort(ord), products };
  };
  RM.setConfirmation = async (id, view, keyStr, checked, comment) => {
    if (!RM.VIEWS[view]) throw new Error('切り口が不正です');
    RM.keyFilter(view, keyStr);
    const rec = (await RM.db.get('confs', id)) || { id, items: {} };
    const ts = now();
    rec.items[view + '|' + keyStr] = { checked: !!checked, comment: String(comment).slice(0, 1000), updated_at: ts };
    await RM.db.put('confs', rec);
    if (view === 'slip') await RM.refreshSummary(id);
    return ts;
  };

  // ================================================================ Excelレポート
  // ファイル名: 受領照合_販売先コード_販売先名_照合対象期間.xlsx(ファイル名に使えない文字は全角に置き換え)
  RM.reportFileName = m => {
    const safe = v => String(v || '').trim().replace(/[\\/:*?"<>|]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/\s+/g, ' ');
    const parts = ['受領照合', safe(m.cust), safe(m.cust_name), `${m.date_from.replace(/-/g, '')}-${m.date_to.replace(/-/g, '')}`].filter(Boolean);
    return parts.join('_') + '.xlsx';
  };
  /** 切り口ごとの比較項目(画面・Excelで共通)。並びは 数量・重量・金額 で統一。idx は [金額,数量,重量] の位置 */
  RM.measures = view => (RM.VIEWS[view] && RM.VIEWS[view].full)
    ? [{ key: 'qty', label: '数量', idx: 1, fmt: 2 }, { key: 'wt', label: '重量', idx: 2, fmt: 3 }, { key: 'amt', label: '金額', idx: 0, fmt: 1 }]
    : [{ key: 'amt', label: '金額', idx: 0, fmt: 1 }];
  const mval = (arr, m) => (m.idx === 0 ? arr[0] : arr[m.idx] / 1000);
  // 数量は整数なら小数点を付けない書式(金額と同じ #,##0)にする
  const qfmt = (m, v) => (m.key === 'qty' && Number.isInteger(v) ? 1 : m.fmt);

  RM.buildReport = async id => {
    const m = await RM.getMatch(id), t = await RM.totals(id), cnt = await RM.counts(id);
    const st = RM.xlStyle, FILL = { diff: 1, sonly: 2, ronly: 3 };
    const H = s => ({ v: s, s: st(0, 0, 1) }), B = s => ({ v: s, s: st(0, 0, 2) }), P = v => ({ v, s: st(0, 0, 4) });
    const C = (v, fill = 0, fmt = 0) => ({ v, s: st(fill, fmt, 0) });
    const sheets = [];
    // サマリ: 画面の3枚のカード(売上額・受領額・差額)と同じ並び
    // サマリ上部: 販売先・照合期間を枠で囲んで大きく表示し、取込情報は罫線付きの表にする
    const box = (v, k) => [{ v, s: st(0, 0, k) }, { v: '', s: st(0, 0, k) }];
    const info = (label, v) => [{ v: label, s: st(0, 0, 16) }, C(v), C('')];
    const sum = [[{ v: '受領照合レポート', s: st(0, 0, 3) }], [],
      [H('販売先')].concat(box(`${m.cust}  ${m.cust_name || ''}`.trim(), 14)),
      [H('照合期間')].concat(box(`${fmtDate(m.date_from)} 〜 ${fmtDate(m.date_to)}`, 15)), [],
      info('売上データ', `${m.sales_file}(${t.s_rows.toLocaleString()}行)`),
      info('受領データ', `${m.receipt_file}(${t.r_rows.toLocaleString()}行・${m.layout_name})`),
      info('照合日時', (m.matched_at || '').replace(/-/g, '/')), info('出力日時', now().replace(/-/g, '/')), [],
      [H('売上額(自社)'), H('受領額(得意先)'), H('差額(売上−受領)')],
      [{ v: t.s[0], s: st(0, 0, 5) }, { v: t.r[0], s: st(0, 0, 5) }, { v: t.d[0], s: st(0, 0, t.d[0] ? 6 : 7) }],
      [P('売上データ 合計'), P('受領データ 合計'), P(t.d[0] ? '日別シートで内訳を確認' : '一致')], [],
      [H('切り口'), H('不一致の件数'), H('比較項目')]];
    for (const [k, v] of Object.entries(RM.VIEWS)) sum.push([C(v.label), C(cnt[k]), C(v.full ? '数量・重量・金額' : '金額')]);
    sum.push([C('変換警告'), C(cnt.warn), C('商品コードの変換')]);
    sheets.push({ name: 'サマリ', widths: [24, 26, 26, 10], rows: sum, heights: { 2: 30, 3: 26 },
      merges: ['B3:C3', 'B4:C4', 'B6:C6', 'B7:C7', 'B8:C8', 'B9:C9'] });
    const custTitle = `販売先:${m.cust} ${m.cust_name || ''}`.trim();
    const period = `照合期間:${fmtDate(m.date_from)} 〜 ${fmtDate(m.date_to)}`;
    const top = label => [[{ v: custTitle, s: st(0, 0, 9) }], [{ v: period, s: st(0, 0, 10) }], [{ v: label, s: st(0, 0, 4) }]];
    for (const [view, v] of Object.entries(RM.VIEWS)) {
      const ms = RM.measures(view);
      const head = v.heads.concat(...['売上', '受領', '差異'].map(g => ms.map(x => `${g} ${x.label}`)), ['判定']);
      const rows = top(`${v.label}の照合結果(差異 = 売上 − 受領)`);
      // 見出しの色: キー列・判定=紫、売上=青、受領=オレンジ、差異=濃い灰紫
      rows.push(v.heads.map(H).concat(...[11, 12, 13].map(k => ms.map(x => ({ v: '', s: st(0, 0, k) }))), [H('判定')]));
      head.forEach((t, i) => { rows[rows.length - 1][i].v = t; });
      const data = await RM.aggregate(id, view);
      const tot = { s: [0, 0, 0], r: [0, 0, 0], d: [0, 0, 0] };
      for (const r of data) {
        const f = FILL[r.judge] || 0, out = r.cells.map((c, i) => C((r.tips && r.tips[i]) || c, f));
        for (const tr of [r.s, r.r, r.d]) for (const x of ms) out.push(tr ? C(mval(tr, x), f, qfmt(x, mval(tr, x))) : C(null, f));
        out.push(C(r.judge_short, f));
        rows.push(out);
        for (let i = 0; i < 3; i++) { tot.s[i] += r.s ? r.s[i] : 0; tot.r[i] += r.r ? r.r[i] : 0; tot.d[i] += r.d[i]; }
      }
      const hr = 4, last = hr + data.length;
      const totRow = [{ v: `合計(${data.length.toLocaleString()}件)`, s: st(0, 0, 8) }];
      for (let i = 1; i < v.heads.length; i++) totRow.push({ v: '', s: st(0, 0, 8) });
      for (const arr of [tot.s, tot.r, tot.d]) for (const x of ms) totRow.push({ v: mval(arr, x), s: st(0, qfmt(x, mval(arr, x)), 8) });
      totRow.push({ v: tot.d[0] === 0 ? '一致' : '差異あり', s: st(0, 0, 8) });
      rows.push(totRow);
      const kw = { day: [14], store: [14, 12, 20], slip: [16, 14, 12, 20], dsi: [12, 14, 12, 16, 12, 28], item: [14, 12, 30] }[view];
      sheets.push({ name: v.label.replace('伝票番号別', '伝票別'), freeze: true, freezeRows: hr, filter: true, rows,
        filterRef: `A${hr}:${RM.colName(head.length)}${last}`,
        widths: kw.concat(Array(ms.length * 3).fill(ms.length > 1 ? 11 : 14), [v.full ? 22 : 10]) });
    }
    const wrows = top('商品コードを変換できなかった受領明細').concat([['種別', '取引日付', '相手先注文番号', '店舗', '相手先商品コード', '商品名(受領)', '採用した自社商品コード', '備考', '受領 数量', '受領 重量', '受領 金額', '受領ファイル行'].map(H)]);
    for (const w of await RM.warnings(id)) {
      const f = w.conv_status === 'none' ? 3 : 1;
      wrows.push([C(w.conv_status === 'none' ? '変換不可' : '複数候補', f), C(fmtDate(w.tdate), f), C(w.order_no, f), C(`${w.store} ${w.store_name || (await storeNames(m.cust)).get(w.store) || ''}`.trim(), f), C(w.partner_code, f), C(w.name, f),
        C(w.conv_status === 'none' ? '' : w.own_code, f), C(w.conv_note, f), C(w.qty / 1000, f, Number.isInteger(w.qty / 1000) ? 1 : 2), C(w.wt / 1000, f, 3), C(w.amt, f, 1), C(w.row_no, f)]);
    }
    sheets.push({ name: '変換警告', freeze: true, freezeRows: 4, filter: true, filterRef: `A4:L${wrows.length}`, rows: wrows, widths: [10, 12, 16, 18, 18, 28, 22, 50, 10, 11, 12, 12] });
    return RM.writeXlsx(sheets);
  };

  // ================================================================ バックアップ
  RM.exportBackup = async () => {
    const data = { app: 'receipt-matcher', version: 1, exported_at: now(), stores: {} };
    for (const s of RM.STORE_NAMES) data.stores[s] = await RM.db.all(s);
    return new Blob([JSON.stringify(data)], { type: 'application/json' });
  };
  RM.importBackup = async textData => {
    let data;
    try { data = JSON.parse(textData); } catch (e) { throw new ReadError('バックアップファイルを読めません。'); }
    if (!data || data.app !== 'receipt-matcher' || !data.stores) throw new ReadError('受領照合のバックアップファイルではありません。');
    for (const s of RM.STORE_NAMES) {
      await RM.db.clear(s);
      for (const v of data.stores[s] || []) await RM.db.put(s, v);
    }
    RM._cache = null;
    return data.exported_at;
  };
})(globalThis.RM = globalThis.RM || {});
