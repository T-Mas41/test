/* 業務ロジック: 売上・販売台帳・受領レイアウトの取込、商品コード変換、照合、確認状況、レポート、バックアップ */
(function (RM) {
  'use strict';
  const { text, code, isBlank, number, toAmount, toMilli, date, fmtDate, ReadError } = RM;
  const now = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  RM.now = now;
  const cell = (row, col) => (row ? row[col] : undefined);

  // ================================================================ 売上(固定レイアウト・188列、列は位置で特定)
  RM.SALES_COLS = { cust: 7, cust_name: 8, store: 81, store_name: 82, tdate: 137, order_no: 35, own_code: 9, name: 10, qty: 33, wt: 32, amt: 58, slip_no: 18 };

  function checkHeaders(header, cols, expected, label) {
    const errs = [];
    for (const col of Object.values(cols)) {
      const a = text(cell(header, col));
      if (a !== expected[col - 1]) errs.push(`${col}列目の見出しが「${a || '(空欄)'}」です(想定:「${expected[col - 1]}」)`);
    }
    if (errs.length) throw new ReadError(`${label}のレイアウトが想定と異なります。` + errs.slice(0, 5).join(' / '));
  }

  const hasAny = r => !!r.any || r.some(v => !isBlank(v));
  RM.hasAny = hasAny;

  async function parseSales(buf, cust, dfrom, dto, onProgress) {
    const rows = await RM.readXlsx(buf, { onProgress, cols: Object.values(RM.SALES_COLS) });
    if (!rows.length) throw new ReadError('売上データが空です。');
    checkHeaders(rows[0], RM.SALES_COLS, RM.SALES_HEADERS, '売上データ');
    const C = RM.SALES_COLS, ck = code(cust);
    const lines = [], errors = [];
    const stats = { total: 0, target: 0, skipped_blank: 0, other_cust: 0, out_of_period: 0, error: 0 };
    let custName = '';
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], g = k => cell(r, C[k]);
      if (isBlank(g('tdate')) && isBlank(g('order_no')) && isBlank(g('own_code'))) {
        if (hasAny(r)) stats.skipped_blank++;
        continue;
      }
      stats.total++;
      if (code(g('cust')) !== ck) { stats.other_cust++; continue; }
      let td, q, w, a;
      try { td = date(g('tdate')); q = number(g('qty')); w = number(g('wt')); a = number(g('amt')); }
      catch (e) { stats.error++; errors.push({ file: '売上', row: i + 1, msg: e.message }); continue; }
      if (td < dfrom || td > dto) { stats.out_of_period++; continue; }
      custName = custName || text(g('cust_name'));
      lines.push({ row_no: i + 1, store: code(g('store')), store_name: text(g('store_name')), tdate: td, order_no: code(g('order_no')),
        slip_no: text(g('slip_no')), own_code: code(g('own_code')), name: text(g('name')), qty: toMilli(q), wt: toMilli(w), amt: toAmount(a) });
    }
    stats.target = lines.length;
    return { lines, errors, stats, custName };
  }

  // ================================================================ 販売台帳
  RM.LEDGER_COLS = { deleted: 1, own_code: 59, own_name: 60, partner_code: 72, cust: 111, cust_name: 112, store: 113 };
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
      const pc = code(g('partner_code')), oc = code(g('own_code'));
      if (!pc || !oc) { skipped++; continue; }
      recs.push([code(g('cust')), text(g('cust_name')), code(g('store')) || RM.STORE_ANY, pc, oc, text(g('own_name'))]);
    }
    const meta = { file_name: fileName, imported_at: now(), total_rows: total, loaded_rows: recs.length, deleted_rows: deleted, skipped_rows: skipped };
    await RM.db.put('kv', { k: 'ledger', meta, rows: recs });
    return meta;
  }
  async function ledger() { return (await RM.db.get('kv', 'ledger')) || { meta: null, rows: [] }; }
  RM.ledgerRows = async () => (await ledger()).rows.map(r => ({ cust: r[0], cust_name: r[1], store: r[2], partner_code: r[3], own_code: r[4], own_name: r[5] }));
  RM.ledgerMeta = async () => (await ledger()).meta;
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
    const used = new Set(), map = {};
    header.forEach((h, i) => { const r = SUGGEST[h]; if (r && !used.has(r)) { map[i + 1] = r; used.add(r); } });
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
  RM.VIEWS = {
    day: { label: '日別', keys: ['tdate'], k1: '取引日付', k2: '' },
    store: { label: '日別店別', keys: ['tdate', 'store'], k1: '取引日付', k2: '店舗' },
    slip: { label: '伝票番号別', keys: ['order_no'], k1: '相手先注文番号', k2: '取引日付・店舗' },
    item: { label: '日別商品別', keys: ['tdate', 'own_code'], k1: '取引日付', k2: '自社商品コード・商品名' },
  };
  RM.JUDGE = { ok: ['一致', 'b-ok', ''], diff: ['差異あり', 'b-diff', 'r-diff'], sonly: ['自社のみ', 'b-s', 'r-s'], ronly: ['受領のみ', 'b-r', 'r-r'] };
  const MAX_ERRORS = 500;

  /** ファイルを読み込み、下書き(未保存)を返す。確定は confirm。 */
  RM.stage = async ({ cust, dateFrom, dateTo, salesName, salesBuf, receiptName, receiptBuf, parentId, onProgress }) => {
    cust = code(cust);
    if (!cust) throw new ReadError('販売先コードを入力してください。');
    if (dateFrom > dateTo) throw new ReadError('期間の From が To より後になっています。');
    const [lay, assigned] = await RM.layoutFor(cust);
    if (!lay) throw new ReadError('標準レイアウトが登録されていません。受領レイアウト画面で標準を指定してください。');
    onProgress && onProgress('売上データを読み込んでいます…');
    const s = await parseSales(salesBuf, cust, dateFrom, dateTo, n => onProgress && onProgress(`売上データを読み込んでいます…(${n.toLocaleString()}行)`));
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
  function compare(s, r) {
    const S = s ? [s.a, s.q, s.w] : [0, 0, 0], R = r ? [r.a, r.q, r.w] : [0, 0, 0];
    const d = [S[0] - R[0], S[1] - R[1], S[2] - R[2]];
    const judge = !s ? 'ronly' : !r ? 'sonly' : (d.every(v => v === 0) ? 'ok' : 'diff');
    const items = ['金額', '数量', '重量'].filter((_, i) => d[i] !== 0);
    const [label, badge, rowCls] = RM.JUDGE[judge];
    return { s: s ? S : null, r: r ? R : null, d, judge, judge_label: judge === 'diff' ? `差異あり(${items.join('・')})` : label,
      judge_short: label, badge, row_cls: rowCls, ok: judge === 'ok' };
  }
  RM.compare = compare;
  function aggregateKeys(l, keys, filt) {
    const sd = side(l.sales, keys, filt, false), rd = side(l.receipt, keys, filt, true);
    const all = [...new Set([...sd.keys(), ...rd.keys()])].sort();
    return all.map(k => { const s = sd.get(k), r = rd.get(k); return Object.assign(compare(s, r), { key: (s || r).key, key_str: k, srow: s, rrow: r }); });
  }
  const md = set => [...set].sort().map(d => d.slice(5).replace('-', '/')).join(',');

  RM.aggregate = async (id, view) => {
    const v = RM.VIEWS[view], l = await lines(id), cf = await confs(id);
    const rows = aggregateKeys(l, v.keys);
    for (const row of rows) {
      const k = row.key, s = row.srow, r = row.rrow;
      const sname = (s && s.sname) || (r && r.sname) || '';
      if (view === 'day') { row.k1 = fmtDate(k[0]); row.k2 = ''; }
      else if (view === 'store') { row.k1 = fmtDate(k[0]); row.k2 = `${k[1]} ${sname}`.trim(); }
      else if (view === 'item') { row.k1 = fmtDate(k[0]); row.k2 = `${k[1]} ${(s && s.iname) || (r && r.iname) || ''}`.trim(); }
      else {
        const sd = s ? md(s.dates) : '', rd = r ? md(r.dates) : '';
        const dates = s && r && sd !== rd ? `売上 ${sd} / 受領 ${rd}` : (sd || rd);
        const stores = [...new Set([...(s ? s.stores : []), ...(r ? r.stores : [])])].sort();
        const st = stores.length === 1 ? `${stores[0]} ${sname}`.trim() : stores.join('、');
        row.k1 = k[0]; row.k2 = [dates, st].filter(Boolean).join(' ・ ');
      }
      const c = cf[view + '|' + row.key_str];
      row.checked = !!(c && c.checked); row.comment = c ? c.comment : ''; row.updated_at = c ? c.updated_at : '';
    }
    return rows;
  };
  RM.totals = async id => {
    const l = await lines(id);
    const sum = ls => ls.length ? { a: ls.reduce((t, x) => t + x.amt, 0), q: ls.reduce((t, x) => t + x.qty, 0), w: ls.reduce((t, x) => t + x.wt, 0) } : null;
    const s = sum(l.sales), r = sum(l.receipt);
    const res = compare(s, r);
    res.s = res.s || [0, 0, 0]; res.r = res.r || [0, 0, 0];
    res.s_rows = l.sales.length; res.r_rows = l.receipt.length;
    return res;
  };
  RM.warnings = async id => (await lines(id)).receipt.filter(x => x.conv_status !== 'ok')
    .sort((a, b) => (a.tdate + a.order_no + String(a.row_no).padStart(9, '0')).localeCompare(b.tdate + b.order_no + String(b.row_no).padStart(9, '0')));
  RM.counts = async id => {
    const l = await lines(id), out = {};
    for (const [k, v] of Object.entries(RM.VIEWS)) out[k] = aggregateKeys(l, v.keys).filter(r => !r.ok).length;
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
  RM.reportFileName = m => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `受領照合_${m.cust}_${m.date_from.replace(/-/g, '')}-${m.date_to.replace(/-/g, '')}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.xlsx`;
  };
  RM.buildReport = async id => {
    const m = await RM.getMatch(id), t = await RM.totals(id), cnt = await RM.counts(id);
    const st = RM.xlStyle, FILL = { diff: 1, sonly: 2, ronly: 3 };
    const H = s => ({ v: s, s: st(0, 0, 1) }), B = s => ({ v: s, s: st(0, 0, 2) }), P = v => ({ v, s: st(0, 0, 4) });
    const C = (v, fill = 0, fmt = 0) => ({ v, s: st(fill, fmt, 0) });
    const sheets = [];
    const sum = [[{ v: '受領照合レポート', s: st(0, 0, 3) }], [],
      [B('販売先'), P(`${m.cust} ${m.cust_name || ''}`.trim())],
      [B('期間(取引日付)'), P(`${fmtDate(m.date_from)} 〜 ${fmtDate(m.date_to)}`)],
      [B('売上データ'), P(`${m.sales_file}(${t.s_rows.toLocaleString()}行)`)],
      [B('受領データ'), P(`${m.receipt_file}(${t.r_rows.toLocaleString()}行・${m.layout_name})`)],
      [B('照合日時'), P(m.matched_at || '')], [B('出力日時'), P(now())], [],
      [B('合計の判定'), { v: RM.JUDGE[t.judge][0], s: st(FILL[t.judge] || 0, 0, 0) }],
      [H(''), H('金額(税抜)'), H('数量'), H('重量(kg)')]];
    [['売上(自社)', t.s], ['受領(得意先)', t.r], ['差異(売上−受領)', t.d]].forEach(([lb, v]) => sum.push([C(lb), C(v[0], 0, 1), C(v[1] / 1000, 0, 2), C(v[2] / 1000, 0, 3)]));
    sum.push([], [H('切り口'), H('不一致の件数')]);
    for (const [k, v] of Object.entries(RM.VIEWS)) sum.push([C(v.label), C(cnt[k])]);
    sum.push([C('変換警告'), C(cnt.warn)]);
    sheets.push({ name: 'サマリ', widths: [22, 40, 14, 14], rows: sum });
    for (const [view, v] of Object.entries(RM.VIEWS)) {
      const head = [v.k1].concat(v.k2 ? [v.k2] : [], ['売上 金額', '売上 数量', '売上 重量', '受領 金額', '受領 数量', '受領 重量', '差異 金額', '差異 数量', '差異 重量', '判定', '確認済', 'コメント', '確認更新日時']);
      const rows = [head.map(H)];
      for (const r of await RM.aggregate(id, view)) {
        const f = FILL[r.judge] || 0, out = [C(r.k1, f)];
        if (v.k2) out.push(C(r.k2, f));
        for (const tr of [r.s, r.r]) {
          if (tr) out.push(C(tr[0], f, 1), C(tr[1] / 1000, f, 2), C(tr[2] / 1000, f, 3));
          else out.push(C(null, f), C(null, f), C(null, f));
        }
        out.push(C(r.d[0], f, 1), C(r.d[1] / 1000, f, 2), C(r.d[2] / 1000, f, 3), C(r.judge_label, f), C(r.checked ? '✓' : '', f), C(r.comment, f), C(r.updated_at, f));
        rows.push(out);
      }
      sheets.push({ name: v.label.replace('伝票番号別', '伝票別'), freeze: true, filter: true, rows,
        widths: [16].concat(v.k2 ? [34] : [], [13, 10, 11, 13, 10, 11, 13, 10, 11, 20, 8, 40, 17]) });
    }
    const wrows = [['種別', '取引日付', '相手先注文番号', '店舗', '相手先商品コード', '商品名(受領)', '採用した自社商品コード', '備考', '受領 金額', '受領 数量', '受領 重量', '受領ファイル行'].map(H)];
    for (const w of await RM.warnings(id)) {
      const f = w.conv_status === 'none' ? 3 : 1;
      wrows.push([C(w.conv_status === 'none' ? '変換不可' : '複数候補', f), C(fmtDate(w.tdate), f), C(w.order_no, f), C(w.store, f), C(w.partner_code, f), C(w.name, f),
        C(w.conv_status === 'none' ? '' : w.own_code, f), C(w.conv_note, f), C(w.amt, f, 1), C(w.qty / 1000, f, 2), C(w.wt / 1000, f, 3), C(w.row_no, f)]);
    }
    sheets.push({ name: '変換警告', freeze: true, filter: true, rows: wrows, widths: [10, 12, 16, 14, 18, 28, 22, 50, 12, 10, 11, 12] });
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
