/* 画面(A案デザイン)。ハッシュ(#/...)で画面を切り替える1ページ構成。 */
(function (RM) {
  'use strict';
  const { fAmt, fQty, fWt, signed, fmtDate, code } = RM;
  const $ = s => document.querySelector(s);
  const h = v => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PAGE_ROWS = 500;
  let flash = null;   // {msg|err}
  let draft = null;   // 取込済み・未確定の照合

  // ---------------------------------------------------------------- 共通
  function go(path, msg) { if (msg) flash = msg; if (location.hash === '#' + path) render(); else location.hash = path; }
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [p, q] = raw.split('?');
    return { path: p, q: new URLSearchParams(q || '') };
  }
  const qs = o => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined && v !== false) u.set(k, v); const s = u.toString(); return s ? '?' + s : ''; };
  function busy(on, text) {
    const o = $('#busy');
    o.hidden = !on;
    if (text) $('#busy-text').textContent = text;
  }
  async function readFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return null;
    return { name: f.name, buf: new Uint8Array(await f.arrayBuffer()) };
  }
  // 保存: Edge/Chrome の「名前を付けて保存」ダイアログを使う(file:// ではダウンロード名の指定が効かないため)
  const SAVE_TYPES = { xlsx: { description: 'Excel ブック', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } },
    json: { description: 'バックアップ', accept: { 'application/json': ['.json'] } } };
  async function saveFile(name, kind, produce) {
    let handle = null;
    if (window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [SAVE_TYPES[kind]] }); }
      catch (e) { if (e && e.name === 'AbortError') return false; handle = null; }
    }
    const blob = await produce();
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
      return true;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }
  const head = (title, sub, actions = '', back = '') => `<div class="head"><div>${back}<h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${actions ? `<div class="right">${actions}</div>` : ''}</div>`;
  const judgeBadge = m => `<span class="b ${m.total_judge === 'ok' ? 'b-ok' : 'b-diff'}">${m.total_judge === 'ok' ? '一致' : '不一致'}</span>`;
  const FMT = { amt: fAmt, qty: fQty, wt: fWt };
  const fmtM = (x, arr) => FMT[x.key](arr[x.idx]);
  const dcell = (fn, v) => `<span class="${v === 0 ? 'zero' : v < 0 ? 'neg' : 'pos'}">${h(signed(fn, v))}</span>`;
  const dt = s => h((s || '').replace(/-/g, '/'));
  const ICON_UP = '<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
  const ICON_OK = '<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/></svg>';
  // ファイル選択欄: 未選択/セット済みを色・アイコン・文言ではっきり区別する
  const dropBox = (name, label, accept) => `<div class="dropwrap">
    <label class="drop" data-label="${h(label)}">
      <input type="file" name="${name}" accept="${accept}" required class="drop-input">
      <span class="drop-icon icon-empty">${ICON_UP}</span><span class="drop-icon icon-set">${ICON_OK}</span>
      <span class="drop-text"><strong class="drop-title">${h(label)}</strong><span class="drop-sub">ここにドラッグ&ドロップ、またはクリックして選択</span></span>
      <span class="drop-state">未選択</span>
    </label>
    <button type="button" class="btn btn-s drop-clear" hidden>選択を取り消す</button></div>`;
  function setDropState(inp) {
    const d = inp.closest('.drop'), w = inp.closest('.dropwrap'), f = inp.files && inp.files[0];
    d.classList.toggle('is-set', !!f);
    d.querySelector('.drop-title').textContent = f ? f.name : d.dataset.label;
    d.querySelector('.drop-sub').textContent = f ? `${(f.size / 1024).toLocaleString('en-US', { maximumFractionDigits: 0 })} KB ・ クリックで選び直し` : 'ここにドラッグ&ドロップ、またはクリックして選択';
    d.querySelector('.drop-state').textContent = f ? '✓ セット済み' : '未選択';
    if (w) w.querySelector('.drop-clear').hidden = !f;
  }
  const opt = (v, label, sel) => `<option value="${h(v)}"${sel ? ' selected' : ''}>${h(label)}</option>`;

  async function customers() {
    const m = new Map();
    for (const [c, n] of await RM.ledgerCustomers()) m.set(c, n || '');
    for (const a of await RM.assignments()) if (!m.has(a.cust)) m.set(a.cust, a.cust_name || '');
    for (const x of await RM.listMatches()) if (!m.has(x.cust)) m.set(x.cust, x.cust_name || '');
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  function pager(page, pages, total, href) {
    if (pages <= 1) return '';
    return `<div class="row pager" style="margin-top:8px"><span class="sub">${fAmt(total)}行中 ${fAmt((page - 1) * PAGE_ROWS + 1)}〜${fAmt(Math.min(page * PAGE_ROWS, total))}行目</span><div class="right">
      ${page > 1 ? `<a class="btn btn-s" href="${href(page - 1)}">前へ</a>` : ''}<span>${page} / ${pages}</span>${page < pages ? `<a class="btn btn-s" href="${href(page + 1)}">次へ</a>` : ''}</div></div>`;
  }

  // ---------------------------------------------------------------- ホーム(ダッシュボード)
  async function pageHome() {
    const ms = await RM.listMatches(), meta = await RM.ledgerMeta(), lays = await RM.layouts(), asg = await RM.assignments();
    const unc = ms.reduce((t, m) => t + (m.unchecked_rows || 0), 0), uncM = ms.filter(m => m.unchecked_rows > 0).length;
    const steps = [
      { no: '01', name: '販売台帳の取込', done: !!meta, text: meta ? `取込済(${fAmt(meta.loaded_rows)}件)` : '未取込', href: '#/ledger' },
      { no: '02', name: '受領レイアウト', done: lays.some(l => l.is_standard), text: `標準+割当 ${asg.length}件`, href: '#/layouts' },
      { no: '03', name: '照合の実行', done: ms.length > 0, text: ms.length ? `${ms.length}件 照合済` : '未実施', href: '#/new' },
      { no: '04', name: '差異の確認', done: ms.length > 0 && unc === 0, text: !ms.length ? '未実施' : unc ? `未確認 ${unc}件` : 'すべて確認済', href: '#/matches' + (unc ? '?unchecked=1' : '') },
    ];
    const pct = Math.round(steps.filter(x => x.done).length / steps.length * 100);
    const cur = steps.findIndex(x => !x.done);
    const recent = ms.slice(0, 5);
    return { nav: 'list', title: 'ホーム', html: `
${head('作業ダッシュボード', '売上データと受領データの照合状況を確認できます', '<a href="#/new" class="btn btn-p">+ 照合データを取り込む</a>')}
<div class="cards">
  <div class="card stat"><div class="k">販売台帳</div>${meta ? `<div class="v">${fAmt(meta.loaded_rows)}<span class="sub"> 件</span></div><div class="d">最終取込 ${dt(meta.imported_at)}</div>` : '<div class="v warnv">未取込</div><div class="d"><a href="#/ledger">取り込んでください</a></div>'}</div>
  <div class="card stat"><div class="k">受領レイアウト</div><div class="v">${lays.length}<span class="sub"> 件</span></div><div class="d">得意先割当 ${asg.length}件</div></div>
  <div class="card stat"><div class="k">照合</div><div class="v">${ms.length}<span class="sub"> 件</span></div><div class="d">不一致 ${ms.filter(m => m.total_judge !== 'ok').length}件</div></div>
  <div class="card stat"><div class="k">未確認の差異(伝票別)</div><div class="v ${unc ? 'warnv' : ''}">${unc}<span class="sub"> 件</span></div><div class="d">${uncM}照合にまたがる</div></div>
  <div class="card wide2"><div class="row"><h2>作業ステップ</h2><span class="right sub">進み具合 ${pct}%</span></div>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="作業の進み具合"><i style="width:${pct}%"></i></div>
    <ol class="vsteps">${steps.map((x, i) => `<li class="${x.done ? 'done' : i === cur ? 'current' : ''}">
      <span class="num">${x.done ? '✓' : i + 1}</span>
      <div class="vs-body"><b>${x.name}</b><span>${h(x.text)}</span></div>
      <span class="vs-state">${x.done ? '完了' : i === cur ? '次の作業' : '未実施'}</span>
      <a class="btn btn-s ${i === cur ? 'btn-p' : ''}" href="${x.href}">${i === cur ? '進める' : '開く'}</a></li>`).join('')}</ol></div>
  <div class="card wide2"><div class="row"><h2>最近の照合</h2><div class="right"><a href="#/matches" class="btn btn-s">すべて見る</a></div></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>販売先</th><th>期間</th><th class="n">差異(金額)</th><th class="n">未確認</th><th>判定</th></tr></thead>
    <tbody>${recent.map(m => `<tr><td><a href="#/match/${m.id}">${h(m.cust)} ${h(m.cust_name || '')}</a></td><td>${fmtDate(m.date_from).slice(5)}〜${fmtDate(m.date_to).slice(5)}</td>
      <td class="n">${h(signed(fAmt, m.total_diff_amt || 0))}</td><td class="n">${m.unchecked_rows || 0}</td><td>${judgeBadge(m)}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="zero">照合はまだありません。</td></tr>'}</tbody></table></div></div>
</div>` };
  }

  // ---------------------------------------------------------------- 照合一覧
  async function pageList(q) {
    const f = { cust: q.get('cust') || '', dateFrom: '', dateTo: '', unchecked: q.get('unchecked') === '1' };
    try { if (q.get('from')) f.dateFrom = RM.date(q.get('from')); if (q.get('to')) f.dateTo = RM.date(q.get('to')); } catch (_) { /* 無効な日付は無視 */ }
    const rows = await RM.listMatches(f), all = await RM.listMatches();
    const unc = all.reduce((t, m) => t + (m.unchecked_rows || 0), 0), uncM = all.filter(m => m.unchecked_rows > 0).length;
    const custs = await customers();
    return { nav: 'matches', title: '照合一覧', html: `
${head('照合一覧', `全 ${all.length}件 ・ 未確認の差異 ${unc}件(${uncM}照合)`, '<a href="#/new" class="btn btn-p">+ 新規照合</a>')}
<section class="card">
  <form class="filters" data-form="list-filter">
    <label class="lbl">販売先<select name="cust" class="fld"><option value="">すべて</option>${custs.map(([c, n]) => opt(c, `${c} ${n}`, c === f.cust)).join('')}</select></label>
    <label class="lbl">期間 From<input class="fld" name="from" value="${h(q.get('from') || '')}" placeholder="YYYY/MM/DD"></label>
    <label class="lbl">期間 To<input class="fld" name="to" value="${h(q.get('to') || '')}" placeholder="YYYY/MM/DD"></label>
    <label class="chk"><input type="checkbox" name="unchecked" value="1"${f.unchecked ? ' checked' : ''}> 未確認の差異があるものだけ</label>
    <button class="btn" type="submit">絞り込み</button>
  </form>
  <div class="tblwrap"><table class="tbl">
    <thead><tr><th>販売先</th><th>期間(取引日付)</th><th>照合日時</th><th>合計判定</th><th class="n">合計差異(金額)</th><th class="n">不一致(伝票別)</th><th class="n">未確認</th><th>操作</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${h(r.cust)} ${h(r.cust_name || '')}</td><td>${fmtDate(r.date_from)}〜${fmtDate(r.date_to)}</td><td>${dt(r.matched_at)}</td>
      <td>${judgeBadge(r)}</td>
      <td class="n">${h(signed(fAmt, r.total_diff_amt || 0))}</td><td class="n">${r.slip_diff_rows || 0}</td><td class="n">${r.unchecked_rows || 0}</td>
      <td><div class="row" style="gap:6px"><a href="#/match/${r.id}" class="btn btn-s">開く</a>
        <button type="button" class="btn btn-s" data-act="report" data-id="${r.id}">Excel出力</button>
        <button type="button" class="btn btn-s btn-danger" data-act="delete-match" data-id="${r.id}">削除</button></div></td></tr>`).join('') ||
      '<tr><td colspan="8" class="zero">照合はまだありません。「新規照合」から始めてください。</td></tr>'}</tbody>
  </table></div>
</section>` };
  }

  // ---------------------------------------------------------------- 新規照合・取込
  async function pageNew(q) {
    const parent = q.get('parent') ? await RM.getMatch(+q.get('parent')) : null;
    const meta = await RM.ledgerMeta(), asg = await RM.assignments();
    const std = (await RM.layouts()).find(l => l.is_standard);
    const lmap = Object.fromEntries((await RM.layouts()).map(l => [l.id, l.name]));
    return { nav: 'new', title: parent ? '再取込・再照合' : '新規照合', html: `
${head(parent ? '再取込・再照合' : '新規照合', '期間を指定して、売上データと受領データを取り込みます(販売先は売上データから自動で判定)')}
${meta ? '' : '<div class="msg msg-warn">販売台帳が未取込です。受領データの商品コードがすべて「変換不可」になります。先に<a href="#/ledger">販売台帳</a>を取り込んでください。</div>'}
<form data-form="new" style="display:flex;flex-direction:column;gap:18px;max-width:1100px">
${parent ? `<input type="hidden" name="parent" value="${parent.id}">` : ''}
<section class="card">
  <h2><span class="step">1</span>照合条件(期間)</h2>
  <div class="filters">
    ${parent ? `<div class="lbl">販売先(再取込元)<div class="fld" style="display:flex;align-items:center;min-width:220px">${h(parent.cust)} ${h(parent.cust_name || '')}</div></div>` : ''}
    <label class="lbl">取引日付 From<input class="fld" name="from" required placeholder="YYYY/MM/DD" value="${parent ? fmtDate(parent.date_from) : ''}" style="width:150px"></label>
    <label class="lbl">取引日付 To<input class="fld" name="to" required placeholder="YYYY/MM/DD" value="${parent ? fmtDate(parent.date_to) : ''}" style="width:150px"></label>
  </div>
  <div class="sub"><strong>販売先は、取り込んだ売上データの販売先コードから自動で判定します</strong>(1つの売上データに複数の販売先が含まれている場合はエラーになります)。</div>
  <div class="sub">使用する受領レイアウト:判定した販売先に割当があればそのレイアウト、なければ <strong>${h(std ? std.name : '(標準未設定)')}</strong>。
  ${asg.length ? '割当のある販売先:' + asg.map(a => `${h(a.cust)}→${h(lmap[a.layout_id] || '')}`).join('、') : ''}</div>
  ${parent ? '<div class="sub">確定すると、この照合の明細を新しいファイルの内容で置き換えます。確認済み・コメントは同じキーの行に引き継がれます。</div>' : ''}
</section>
<section class="card">
  <h2><span class="step">2</span>ファイル取込</h2>
  <div class="grid2">
    <div style="display:flex;flex-direction:column;gap:8px"><strong>自社売上データ(Excel .xlsx)</strong>${dropBox('sales', '売上データ(.xlsx)', '.xlsx')}</div>
    <div style="display:flex;flex-direction:column;gap:8px"><strong>受領データ(Excel .xlsx / CSV)</strong>${dropBox('receipt', '受領データ(.xlsx / .csv)', '.xlsx,.csv,.txt')}</div>
  </div>
  <div class="sub">次の画面で、取込件数・エラー・変換警告を確認してから照合を確定します。ファイルはこのPCの中だけで読み込まれます。</div>
</section>
<div class="row"><div class="right"><a href="${parent ? '#/match/' + parent.id : '#/'}" class="btn">キャンセル</a><button type="submit" class="btn btn-p">取り込んで確認</button></div></div>
</form>` };
  }

  function pageReview() {
    if (!draft) return { redirect: '/new' };
    const m = draft, s = m.stats.sales, r = m.stats.receipt, st = m.stats;
    const kv = x => `<div class="kv"><div>データ行</div><div>${fAmt(x.total)}行</div><div>照合対象</div><div><strong>${fAmt(x.target)}行</strong></div>
      <div>対象外</div><div>他の販売先 ${fAmt(x.other_cust)}行 / 期間外 ${fAmt(x.out_of_period)}行</div>
      <div>読み飛ばし</div><div>${fAmt(x.skipped_blank)}行(空行・合計行など)</div><div>エラー</div><div>${x.error ? `<span class="neg">${x.error}行</span>` : 'なし'}</div></div>`;
    return { nav: 'new', title: '取込結果の確認', html: `
${head('取込結果の確認', '件数・エラー・変換警告を確認してから照合を実行します')}
<div class="info">
  <div><div class="k">販売先</div><div class="v">${h(m.cust)} ${h(m.cust_name)}</div></div>
  <div><div class="k">期間(取引日付)</div><div class="v">${fmtDate(m.date_from)}〜${fmtDate(m.date_to)}</div></div>
  <div><div class="k">受領レイアウト</div><div class="v">${h(m.layout_name)}${st.layout_assigned ? '' : '(割当なし→標準)'}</div></div>
  ${m.parent_id ? '<div><div class="k">再取込</div><div class="v">既存の照合を置き換えます</div></div>' : ''}
</div>
<div class="grid2">
  <section class="card"><h2>自社売上データ:${h(m.sales_file)}</h2><div class="msg msg-ok">レイアウト検査:OK(188列・見出し一致)</div>${kv(s)}</section>
  <section class="card"><h2>受領データ:${h(m.receipt_file)}</h2>
    ${r.conv_none || r.conv_multi ? `<div class="msg msg-warn">商品コード:変換不可 ${r.conv_none}件、複数候補 ${r.conv_multi}件(照合後に「変換警告」で確認できます)</div>` : '<div class="msg msg-ok">商品コード:すべて販売台帳で変換できました</div>'}
    ${st.ledger_empty ? '<div class="msg msg-warn">販売台帳が未取込です。</div>' : ''}${kv(r)}</section>
</div>
<section class="card"><h2>取込エラー</h2>
${m.errors.length ? `<div class="sub">エラーの行は照合の対象から除かれます。${st.error_count > m.errors.length ? `(先頭 ${m.errors.length}件を表示 / 全 ${st.error_count}件)` : ''}</div>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>ファイル</th><th class="n">行</th><th>内容</th></tr></thead><tbody>
  ${m.errors.map(e => `<tr><td>${h(e.file)}</td><td class="n">${e.row}</td><td>${h(e.msg)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="sub">エラー行はありません。</div>'}
</section>
<div class="row"><div class="right"><button type="button" class="btn" data-act="review-cancel">中止</button>
  <button type="button" class="btn btn-p" data-act="review-confirm">${st.error_count ? 'エラー行を除いて照合を実行' : '照合を実行'}</button></div></div>` };
  }

  // ---------------------------------------------------------------- 照合結果
  async function pageResult(id, q) {
    const m = await RM.getMatch(id);
    if (!m) return { redirect: '/matches', flash: { err: '照合が見つかりません。' } };
    let view = q.get('view') || 'day';
    if (!RM.VIEWS[view] && view !== 'warn') view = 'day';
    const onlyDiff = q.get('only_diff') === '1', onlyUnc = q.get('only_unc') === '1', kw = (q.get('q') || '').trim();
    const t = await RM.totals(id), cnt = await RM.counts(id);
    let rows = [], warns = [];
    if (view === 'warn') warns = await RM.warnings(id);
    else {
      rows = await RM.aggregate(id, view);
      if (onlyDiff) rows = rows.filter(r => !r.ok);
      if (onlyUnc) rows = rows.filter(r => !r.ok && !r.checked);
      if (kw) rows = rows.filter(r => r.k1.includes(kw) || r.k2.includes(kw) || r.comment.includes(kw));
    }
    const total = view === 'warn' ? warns.length : rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_ROWS));
    const page = Math.min(Math.max(1, +(q.get('page') || 1)), pages);
    rows = rows.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);
    warns = warns.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS);
    const base = '#/match/' + id;
    const href = p => base + qs({ view, only_diff: onlyDiff ? 1 : '', only_unc: onlyUnc ? 1 : '', q: kw, page: p });
    const V = RM.VIEWS[view], ms = RM.measures(view);
    const tabs = Object.entries(RM.VIEWS).map(([k, v]) => `<a class="tab ${view === k ? 'on' : ''}" href="${base + qs({ view: k, only_diff: onlyDiff ? 1 : '', only_unc: onlyUnc ? 1 : '' })}">${v.label} <span class="cnt ${cnt[k] ? 'has' : ''}">${cnt[k]}</span></a>`).join('') +
      `<a class="tab ${view === 'warn' ? 'on' : ''}" href="${base}?view=warn">変換警告 <span class="cnt ${cnt.warn ? 'has' : ''}">${cnt.warn}</span></a>`;
    let body;
    if (view !== 'warn') {
      body = `
  <form class="bar" data-form="result-filter" data-base="${base}" data-view="${view}">
    <label class="chk"><input type="checkbox" name="only_diff" value="1" class="js-autosubmit"${onlyDiff ? ' checked' : ''}> 不一致のみ表示</label>
    <label class="chk"><input type="checkbox" name="only_unc" value="1" class="js-autosubmit"${onlyUnc ? ' checked' : ''}> 未確認のみ表示</label>
    <label class="chk">検索 <input type="search" name="q" value="${h(kw)}" class="cin" placeholder="日付・番号・商品・コメント"></label>
    <button type="submit" class="btn btn-s">表示</button>
    <span class="legend"><span class="b b-diff">差異あり</span><span class="b b-s">自社のみ</span><span class="b b-r">受領のみ</span><span class="b b-ok">一致</span></span>
  </form>
  <div class="inner"><div class="tblscroll"><table class="tbl compact sticky">
    <thead><tr>${V.heads.map(x => `<th>${x}</th>`).join('')}
      ${[['gs', '売上'], ['gr', '受領'], ['gd', '差異']].map(([c, g]) => ms.map(x => `<th class="${c} n${x.key === 'amt' ? ' amt' : ''}">${g}${ms.length > 1 ? '<br>' : ' '}${x.label}</th>`).join('')).join('')}
      <th>判定</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.row_cls} js-conf" data-id="${id}" data-view="${view}" data-key="${h(r.key_str)}">
      <td><a href="${base}/detail${qs({ view, key: r.key_str })}" title="明細を表示">${h(r.cells[0])}</a></td>${r.cells.slice(1).map((c, i) => `<td class="txt" title="${h((r.tips && r.tips[i + 1]) || c)}">${h(c)}</td>`).join('')}
      ${[['as', r.s], ['ar', r.r]].map(([c, tr]) => ms.map(x => tr ? `<td class="n${x.key === 'amt' ? ' amt ' + c : ''}">${fmtM(x, tr)}</td>` : `<td class="n zero${x.key === 'amt' ? ' amt ' + c : ''}">—</td>`).join('')).join('')}
      ${ms.map(x => `<td class="n${x.key === 'amt' ? ' amt ad' : ''}">${dcell(FMT[x.key], r.d[x.idx])}</td>`).join('')}
      <td><span class="b ${r.badge}" title="${h(r.judge_label)}">${r.judge_short}</span></td>
</tr>`).join('') ||
      `<tr><td colspan="${V.heads.length + ms.length * 3 + 1}" class="zero" style="text-align:center;padding:24px">条件に合う行はありません。</td></tr>`}</tbody></table></div>
    ${pager(page, pages, total, href)}
    <p class="note" style="margin-top:8px">${V.k1}をクリックすると明細を表示します。差異の確認済み・コメントは明細画面で入力します。差異 = 売上 − 受領。</p></div>`;
    } else {
      body = `<div class="inner" style="padding-top:12px"><table class="tbl compact">
    <thead><tr><th>種別</th><th>取引日付</th><th>相手先注文番号</th><th>店舗</th><th>相手先商品コード</th><th>商品名(受領)</th><th>採用した自社商品コード</th><th>備考</th><th class="n">受領金額</th><th class="n">受領ファイル行</th></tr></thead>
    <tbody>${warns.map(w => `<tr><td><span class="b ${w.conv_status === 'none' ? 'b-r' : 'b-diff'}">${w.conv_status === 'none' ? '変換不可' : '複数候補'}</span></td>
      <td>${fmtDate(w.tdate)}</td><td>${h(w.order_no)}</td><td>${h(w.store)} ${h(w.store_name)}</td><td>${h(w.partner_code)}</td><td>${h(w.name)}</td>
      <td>${w.conv_status === 'none' ? '—' : h(w.own_code)}</td><td class="wrap">${h(w.conv_note)}</td><td class="n">${fAmt(w.amt)}</td><td class="n">${w.row_no}</td></tr>`).join('') ||
      '<tr><td colspan="10" class="zero" style="text-align:center;padding:24px">変換警告はありません。</td></tr>'}</tbody></table>
    ${pager(page, pages, total, href)}
    <p class="note" style="margin-top:8px">変換不可の行は、相手先商品コードの頭に「[未変換]」を付けて照合しています。販売台帳に登録してから「再取込・再照合」すると解消します。</p></div>`;
    }
    return { nav: 'matches', title: '照合結果', html: `
${head(`照合結果:${h(m.cust)} ${h(m.cust_name || '')}`, `${fmtDate(m.date_from)}〜${fmtDate(m.date_to)} ・ ${h(m.sales_file)}(${fAmt(t.s_rows)}行) / ${h(m.receipt_file)}(${fAmt(t.r_rows)}行・${h(m.layout_name)}) ・ 照合日時 ${dt(m.matched_at)}`,
  `<a href="#/new?parent=${id}" class="btn">再取込・再照合</a><button type="button" class="btn btn-p" data-act="report" data-id="${id}">Excelレポート出力</button>`, '<a href="#/matches" class="back">← 照合一覧</a>')}
<div class="tcards" aria-label="合計の照合">
  <div class="tcard"><div class="k">売上額(自社)</div><div class="v">${fAmt(t.s[0])}</div><div class="d">売上データ 合計(${fAmt(t.s_rows)}行)</div></div>
  <div class="tcard"><div class="k">受領額(得意先)</div><div class="v">${fAmt(t.r[0])}</div><div class="d">受領データ 合計(${fAmt(t.r_rows)}行)</div></div>
  <div class="tcard ${t.d[0] ? 'is-diff' : 'is-ok'}"><div class="k">差額(売上−受領)</div><div class="v">${signed(fAmt, t.d[0])}</div>
    <div class="d">${t.d[0] ? `<a href="${base}?view=day">日別で内訳を確認</a>` : '✓ 合計は一致しています'}</div></div>
</div>
<section class="panel"><nav class="tabs" aria-label="照合の切り口">${tabs}</nav>${body}</section>` };
  }

  async function pageDetail(id, q) {
    const m = await RM.getMatch(id), view = q.get('view'), key = q.get('key') || '';
    if (!m || !RM.VIEWS[view]) return { redirect: '/matches', flash: { err: '照合が見つかりません。' } };
    let d;
    try { d = await RM.detail(id, view, key); } catch (_) { return { redirect: '/match/' + id, flash: { err: '明細のキーが不正です。' } }; }
    if (!d.row) return { redirect: '/match/' + id + '?view=' + view, flash: { err: '該当する行がありません。' } };
    const r = d.row, V = RM.VIEWS[view], base = '#/match/' + id;
    const tbl = (title, color, lines, isR, tot) => `<section class="card"><h2 style="color:${color}">${title}${lines.length}行</h2><div class="tblwrap"><table class="tbl">
      <thead><tr><th>取引日付</th><th>注文番号</th><th>店舗</th>${isR ? '<th>相手先商品コード</th><th>変換後の自社商品コード</th><th>商品名(受領)</th>' : '<th>売上伝票番号</th><th>商品コード</th><th>商品名</th>'}<th class="n">数量</th><th class="n">重量</th><th class="n">金額</th></tr></thead>
      <tbody>${lines.map(x => `<tr><td>${fmtDate(x.tdate)}</td><td>${h(x.order_no)}</td><td>${h(x.store)}</td>${isR
        ? `<td>${h(x.partner_code)}</td><td>${h(x.own_code)} ${x.conv_status === 'ok' ? `<span class="b b-ok" title="${h(x.conv_note)}">台帳で変換</span>` : x.conv_status === 'multi' ? `<span class="b b-diff" title="${h(x.conv_note)}">複数候補</span>` : '<span class="b b-r">変換不可</span>'}</td><td>${h(x.name)}</td>`
        : `<td>${h(x.slip_no)}</td><td>${h(x.own_code)}</td><td>${h(x.name)}</td>`}
        <td class="n">${fQty(x.qty)}</td><td class="n">${fWt(x.wt)}</td><td class="n">${fAmt(x.amt)}</td></tr>`).join('') || `<tr><td colspan="9" class="zero">${isR ? '受領' : '売上'}側に明細はありません</td></tr>`}</tbody>
      ${lines.length ? `<tfoot><tr><td colspan="6">計</td><td class="n">${fQty(tot[1])}</td><td class="n">${fWt(tot[2])}</td><td class="n">${fAmt(tot[0])}</td></tr></tfoot>` : ''}</table></div></section>`;
    return { nav: 'matches', title: '明細', html: `
${head(`明細:${V.k1} ${h(r.k1)}`, h(r.k2 || ''), '', `<a href="${base}?view=${view}" class="back">← 照合結果(${V.label})に戻る</a>`)}
<div class="info"><div><div class="k">販売先</div><div class="v">${h(m.cust)} ${h(m.cust_name || '')}</div></div>
  <div><div class="k">判定</div><span class="b ${r.badge}">${h(r.judge_label)}</span></div>
  <div><div class="k">差異(売上−受領)</div><div class="v">${RM.measures(view).map(x => `${x.label} ${dcell(FMT[x.key], r.d[x.idx])}`).join(' / ')}</div></div></div>
<div style="display:flex;flex-direction:column;gap:16px">${tbl('売上明細(自社)', '#3B5CC4', d.sales, false, r.s)}${tbl('受領明細(得意先)', '#9A4A16', d.receipt, true, r.r)}</div>
${view !== 'item' ? `<section class="card"><h2>商品別の比較</h2><div class="tblwrap"><table class="tbl">
  <thead><tr><th>自社商品コード</th><th>商品名</th><th class="n">売上 金額</th><th class="n">受領 金額</th><th class="n">差異 数量</th><th class="n">差異 重量</th><th class="n">差異 金額</th><th>判定</th></tr></thead>
  <tbody>${d.products.map(p => `<tr class="${p.row_cls}"><td>${h(p.key[0])}</td><td>${h(p.name)}</td><td class="n">${p.s ? fAmt(p.s[0]) : '—'}</td><td class="n">${p.r ? fAmt(p.r[0]) : '—'}</td>
    <td class="n">${dcell(fQty, p.d[1])}</td><td class="n">${dcell(fWt, p.d[2])}</td><td class="n">${dcell(fAmt, p.d[0])}</td><td><span class="b ${p.badge}">${h(p.judge_label)}</span></td></tr>`).join('')}</tbody></table></div></section>` : ''}
<section class="card"><h2>確認状況</h2>
  <form data-form="detail-confirm" data-id="${id}" data-view="${view}" data-key="${h(key)}" style="display:flex;flex-direction:column;gap:10px">
    <label class="chk" style="font-size:14px"><input type="checkbox" name="checked" value="1"${r.checked ? ' checked' : ''}> 確認済みにする</label>
    <label class="lbl">コメント<textarea name="comment" rows="3" class="fld" maxlength="1000" placeholder="差異の理由や対応を記入">${h(r.comment)}</textarea></label>
    <div class="sub">最終更新:${r.updated_at ? dt(r.updated_at) : '—'}</div>
    <div class="row"><button type="submit" class="btn btn-p">保存</button><a href="${base}?view=${view}" class="btn">戻る</a></div>
  </form></section>` };
  }

  // ---------------------------------------------------------------- 販売台帳
  async function pageLedger(q) {
    const meta = await RM.ledgerMeta();
    let rows = await RM.ledgerRows();
    const dupMap = RM.ledgerDupKeys(rows), cand = r => dupMap.get(r.cust + '|' + r.store + '|' + r.partner_code).size;
    const dupCount = [...dupMap.values()].filter(s => s.size > 1).length;
    const custs = await RM.ledgerCustomers();
    const cust = q.get('cust') || '', kw = (q.get('q') || '').trim(), dup = q.get('dup') === '1';
    if (cust) rows = rows.filter(r => r.cust === cust);
    if (kw) rows = rows.filter(r => r.partner_code.includes(kw) || r.own_code.includes(kw) || r.own_name.includes(kw));
    if (dup) rows = rows.filter(r => cand(r) > 1);
    rows.sort((a, b) => (a.cust + '|' + a.partner_code + '|' + a.store).localeCompare(b.cust + '|' + b.partner_code + '|' + b.store));
    const per = 100, total = rows.length, pages = Math.max(1, Math.ceil(total / per)), page = Math.min(Math.max(1, +(q.get('page') || 1)), pages);
    const view = rows.slice((page - 1) * per, page * per);
    const href = p => '#/ledger' + qs({ cust, q: kw, dup: dup ? 1 : '', page: p });
    return { nav: 'ledger', title: '販売台帳', html: `
${head('販売台帳', '受領データの相手先商品コードを自社商品コードに変換するためのマスタです')}
<div class="grid2">
  <section class="card"><h2>取込(全件入れ替え)</h2>
    <form data-form="ledger" style="display:flex;flex-direction:column;gap:10px">${dropBox('file', '販売台帳(.xlsx)', '.xlsx')}
      <div class="row"><span class="sub">取り込むと現在の台帳はすべて置き換わります。削除区分「9」の行は取り込みません。</span><div class="right"><button type="submit" class="btn btn-p">取り込む</button></div></div></form></section>
  <section class="card"><h2>現在の台帳</h2>${meta ? `<div class="kv">
    <div>ファイル名</div><div>${h(meta.file_name)}</div><div>取込日時</div><div>${dt(meta.imported_at)}</div>
    <div>取込件数</div><div>${fAmt(meta.loaded_rows)}件(全 ${fAmt(meta.total_rows)}行、削除区分9 を除外 ${fAmt(meta.deleted_rows)}行${meta.skipped_rows ? `、コード空欄で除外 ${fAmt(meta.skipped_rows)}行` : ''})</div>
    <div>注意</div><div>${dupCount ? `<span class="b b-diff">キー重複 ${dupCount}件</span> 同じ販売先+店舗+相手先商品コードに自社商品コードが複数あります(照合時は先頭を採用し警告)。` : 'キー重複はありません。'}</div></div>` : '<div class="sub">まだ取り込まれていません。</div>'}</section>
</div>
<section class="card">
  <form class="filters" data-form="ledger-filter"><h2 style="margin-right:auto">台帳の内容</h2>
    <label class="lbl">販売先<select name="cust" class="fld"><option value="">すべて</option>${custs.map(([c, n]) => opt(c, `${c} ${n}`, c === cust)).join('')}</select></label>
    <label class="lbl">検索<input class="fld" type="search" name="q" value="${h(kw)}" placeholder="商品コード・商品名" style="width:240px"></label>
    <label class="chk" style="height:34px"><input type="checkbox" name="dup" value="1"${dup ? ' checked' : ''}> キー重複のみ</label>
    <button type="submit" class="btn">表示</button></form>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>販売先</th><th>店舗</th><th>販売先商品識別ｺｰﾄﾞ(相手先)</th><th>自社商品コード</th><th>商品略称</th><th>状態</th></tr></thead>
    <tbody>${view.map(r => `<tr><td>${h(r.cust)} ${h(r.cust_name)}</td><td>${h(r.store)}${r.store === RM.STORE_ANY ? ' 指定なし' : ''}</td><td>${h(r.partner_code)}</td><td>${h(r.own_code)}</td><td>${h(r.own_name)}</td>
      <td>${cand(r) > 1 ? '<span class="b b-diff">キー重複</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="zero">該当するデータはありません。</td></tr>'}</tbody></table></div>
  <div class="row"><span class="sub">${fAmt(total)}件 ・ 検索順:①販売先+店舗+相手先コード → ②販売先+店舗「指定なし」+相手先コード</span>
    ${pages > 1 ? `<div class="right pager">${page > 1 ? `<a class="btn btn-s" href="${href(page - 1)}">前へ</a>` : ''}<span>${page} / ${pages}</span>${page < pages ? `<a class="btn btn-s" href="${href(page + 1)}">次へ</a>` : ''}</div>` : ''}</div>
</section>` };
  }

  // ---------------------------------------------------------------- 受領レイアウト・割当
  const fileFields = (l, isNew) => `
    <label class="lbl">レイアウト名<input class="fld" name="name" value="${h(l.name || '')}" required style="width:240px"${isNew ? ' placeholder="例 K社 個別Excel"' : ''}></label>
    <label class="lbl">形式<select class="fld" name="file_type">${opt('excel', 'Excel(.xlsx)', l.file_type === 'excel')}${opt('csv', 'CSV', l.file_type === 'csv')}</select></label>
    <label class="lbl js-csv">文字コード<select class="fld" name="encoding">${Object.entries(RM.ENCODINGS).map(([k, v]) => opt(k, v, l.encoding === k)).join('')}</select></label>
    <label class="lbl js-csv">区切り文字<select class="fld" name="delimiter">${Object.entries(RM.DELIMITERS).map(([k, v]) => opt(k, v, l.delimiter === k)).join('')}</select></label>
    <label class="lbl js-excel">シート名(空欄=先頭)<input class="fld" name="sheet_name" value="${h(l.sheet_name || '')}" style="width:160px"></label>
    <label class="lbl">見出し行<input class="fld" type="number" name="header_row" value="${l.header_row || 1}" min="1" style="width:90px"></label>
    <label class="lbl">データ開始行<input class="fld" type="number" name="data_start_row" value="${l.data_start_row || 2}" min="2" style="width:90px"></label>`;

  async function pageLayouts() {
    const lays = await RM.layouts(), asg = await RM.assignments(), custs = await RM.ledgerCustomers();
    const cnt = id => asg.filter(a => a.layout_id === id).length, lname = Object.fromEntries(lays.map(l => [l.id, l.name]));
    return { nav: 'layouts', title: '受領レイアウト・得意先割当', html: `
${head('受領レイアウト・得意先割当', '得意先ごとの受領データの形式と、どの得意先にどの形式を使うかを設定します')}
<section class="card"><h2>受領レイアウト</h2>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>レイアウト名</th><th>形式</th><th>文字コード</th><th class="n">列数</th><th>見出し行/開始行</th><th class="n">割当得意先</th><th>更新日時</th><th>操作</th></tr></thead>
  <tbody>${lays.map(l => `<tr><td>${l.is_standard ? '<span class="b b-std">標準</span> ' : ''}${h(l.name)}</td>
    <td>${l.file_type === 'excel' ? 'Excel' + (l.sheet_name ? `(シート「${h(l.sheet_name)}」)` : '') : `CSV(${h(RM.DELIMITERS[l.delimiter] || l.delimiter)})`}</td>
    <td>${l.file_type === 'csv' ? h(RM.ENCODINGS[l.encoding] || l.encoding) : '—'}</td><td class="n">${l.columns.length}</td><td>${l.header_row} / ${l.data_start_row}</td>
    <td class="n">${l.is_standard && !cnt(l.id) ? '(割当なしの全得意先)' : cnt(l.id)}</td><td>${dt(l.updated_at)}</td>
    <td><div class="row" style="gap:6px"><a href="#/layout/${l.id}" class="btn btn-s">編集</a>${l.is_standard ? '' : `
      <button type="button" class="btn btn-s" data-act="layout-standard" data-id="${l.id}" data-name="${h(l.name)}">標準にする</button>
      <button type="button" class="btn btn-s btn-danger" data-act="layout-delete" data-id="${l.id}" data-name="${h(l.name)}">削除</button>`}</div></td></tr>`).join('')}</tbody></table></div>
  <details><summary class="btn btn-p" style="display:inline-flex;list-style:none">+ 新規(サンプルファイルから作成)</summary>
    <form data-form="layout-new" style="display:flex;flex-direction:column;gap:12px;margin-top:12px;background:var(--bg);border-radius:6px;padding:14px 16px">
      <div class="filters">${fileFields({ file_type: 'excel', encoding: 'cp932', delimiter: ',' }, true)}</div>
      ${dropBox('file', '受領データのサンプル(.xlsx / .csv)', '.xlsx,.csv,.txt')}
      <div><button type="submit" class="btn btn-p">サンプルを読み込む</button></div></form></details>
  <p class="note">得意先に割り当てられているレイアウトは削除できません(先に割当を解除してください)。</p></section>
<section class="card"><div class="row"><h2>得意先レイアウト割当</h2><span class="sub">ここに無い販売先は「標準」レイアウトで読み込みます</span></div>
  <form class="filters" data-form="assign" style="background:var(--bg);border-radius:6px;padding:12px 14px">
    <label class="lbl">販売先コード<input class="fld" name="cust" list="custs" required placeholder="例 20005530" style="width:170px" autocomplete="off">
      <datalist id="custs">${custs.map(([c, n]) => `<option value="${h(c)}">${h(c)} ${h(n)}</option>`).join('')}</datalist></label>
    <label class="lbl">販売先名(空欄なら台帳から)<input class="fld" name="cust_name" style="width:200px"></label>
    <label class="lbl">レイアウト<select class="fld" name="layout_id">${lays.map(l => opt(l.id, l.name)).join('')}</select></label>
    <button type="submit" class="btn btn-p">追加・変更</button></form>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>販売先コード</th><th>販売先名</th><th>使用レイアウト</th><th>操作</th></tr></thead>
    <tbody>${asg.map(a => `<tr><td>${h(a.cust)}</td><td>${h(a.cust_name)}</td><td>${h(lname[a.layout_id] || '')}</td>
      <td><button type="button" class="btn btn-s btn-danger" data-act="unassign" data-cust="${h(a.cust)}">割当解除</button></td></tr>`).join('') || '<tr><td colspan="4" class="zero">割当はありません(すべて標準レイアウトで読み込みます)。</td></tr>'}</tbody></table></div>
  <p class="note">割当を変更するときは、同じ販売先コードで「追加・変更」してください。</p></section>` };
  }

  async function pageLayoutEdit(id, q) {
    const l = await RM.db.get('layouts', id);
    if (!l) return { redirect: '/layouts', flash: { err: 'レイアウトが見つかりません。' } };
    const all = q.get('all') === '1', used = l.columns.filter(c => c.role).map(c => c.role);
    const problems = RM.validateRoles(l.columns), pv = RM.previewLayout(l), usedRoles = RM.ROLES.filter(r => used.includes(r[0]));
    return { nav: 'layouts', title: '受領レイアウト編集', html: `
${head(`受領レイアウト編集:${h(l.name)}${l.is_standard ? ' <span class="b b-std">標準</span>' : ''}`, '各列を照合で何として使うか(役割)を設定します', '', '<a href="#/layouts" class="back">← 受領レイアウト一覧</a>')}
<form data-form="layout-save" data-id="${id}" style="display:flex;flex-direction:column;gap:18px">
<section class="card"><h2>1. ファイル形式</h2><div class="filters">${fileFields(l, false)}</div>
  <div class="sub">サンプル:${h(l.sample_file || '(初期登録のため見出しのみ)')}(${l.columns.length}列)</div></section>
<section class="card"><div class="row"><h2>2. 項目の役割</h2><div class="right"><a class="btn btn-s" href="#/layout/${id}${all ? '' : '?all=1'}">${all ? '役割を設定した列だけ表示' : 'すべての列を表示'}</a></div></div>
  <div class="row" style="gap:8px;font-size:13px"><span class="sub">必須の役割:</span>${RM.ROLES.filter(r => r[2]).map(([k, lb]) => `<span class="chip ${used.includes(k) ? 'chip-ok' : 'chip-ng'}">${used.includes(k) ? '✓' : '未設定'} ${lb}</span>`).join('')}</div>
  ${problems.map(p => `<div class="msg msg-err">${h(p)}</div>`).join('')}
  <div class="tblwrap"><table class="tbl"><thead><tr><th class="n">列</th><th>見出し名</th><th>サンプル値(1行目)</th><th>役割</th><th>日付書式</th></tr></thead><tbody>
  ${l.columns.filter(c => all || c.role).map(c => `<tr class="${c.role ? 'used' : ''}"><td class="n">${c.col_no}</td><td>${h(c.header)}</td><td>${h((l.sample_rows[0] || [])[c.col_no - 1] || '')}</td>
    <td><select class="fld fld-s" name="role_${c.col_no}" aria-label="${h(c.header)} の役割" style="width:190px"><option value="">未使用</option>${RM.ROLES.map(([k, lb, req]) => opt(k, lb + (req ? '(必須)' : ''), c.role === k)).join('')}</select></td>
    <td>${c.role === 'tdate' ? `<select class="fld fld-s" name="fmt_${c.col_no}" aria-label="日付書式">${Object.entries(RM.DATE_FORMATS).map(([k, v]) => opt(k, v, c.date_format === k)).join('')}</select>` : ''}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="note">${all ? '' : '役割を設定していない列は非表示です。別の列に役割を付けるには「すべての列を表示」を押してください。'}販売先コードの役割がない場合は、照合作成時に指定した販売先として扱います。</p></section>
<div class="row"><div class="right"><a href="#/layouts" class="btn">一覧へ戻る</a><button type="submit" class="btn btn-p">保存</button></div></div>
</form>
<section class="card"><h2>3. 変換結果プレビュー(サンプル先頭${pv.length}行)</h2>
  ${pv.length ? `<div class="tblwrap"><table class="tbl"><thead><tr>${usedRoles.map(r => `<th>${r[1]}</th>`).join('')}</tr></thead>
    <tbody>${pv.map(p => `<tr>${usedRoles.map(r => `<td>${h(p[r[0]] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="note">保存後の設定でプレビューします。</p>`
    : '<div class="sub">サンプルのデータ行がありません。下からサンプルファイルを読み込むとプレビューできます。</div>'}
  <form data-form="layout-sample" data-id="${id}" class="row"><div style="flex:1 1 360px">${dropBox('file', '別のサンプルで読み直す(列の構成が変わった場合など)', '.xlsx,.csv,.txt')}</div>
    <button type="submit" class="btn">読み直す</button></form></section>` };
  }

  // ---------------------------------------------------------------- バックアップ
  async function pageBackup() {
    const est = await RM.db.estimate();
    const ms = await RM.listMatches(), meta = await RM.ledgerMeta();
    const last = (await RM.db.get('kv', 'last_backup')) || null;
    return { nav: 'backup', title: 'バックアップ', html: `
${head('バックアップ・復元', 'データはこのPCのブラウザ内に保存されています')}
<div class="msg msg-warn">データはこのPCのブラウザ内に保存されています。ブラウザの「閲覧データの削除」で「Cookieとサイトデータ」を消すと、データも消えます。定期的にバックアップしてください。</div>
<div class="grid2">
  <section class="card"><h2>バックアップ(ファイルに書き出す)</h2>
    <div class="kv"><div>照合</div><div>${ms.length}件</div><div>販売台帳</div><div>${meta ? fAmt(meta.loaded_rows) + '件' : '未取込'}</div>
      <div>使用容量</div><div>${est && est.usage ? (est.usage / 1048576).toFixed(1) + ' MB' : '—'}</div><div>前回のバックアップ</div><div>${last ? dt(last.at) : 'なし'}</div></div>
    <div><button type="button" class="btn btn-p" data-act="backup">バックアップファイルを保存</button></div>
    <p class="note">すべてのデータ(販売台帳・レイアウト・割当・照合・確認状況)を1つのファイルに保存します。ファイルには業務データが含まれるため、社内の決められた場所に保管してください。</p></section>
  <section class="card"><h2>復元(ファイルから読み込む)</h2>
    <form data-form="restore" style="display:flex;flex-direction:column;gap:10px">${dropBox('file', 'バックアップファイル(.json)', '.json')}
      <div><button type="submit" class="btn btn-danger">復元する</button></div></form>
    <p class="note">復元すると、現在のデータはすべてバックアップの内容に置き換わります。別のPCへの移行にも使えます。</p></section>
</div>` };
  }

  // ---------------------------------------------------------------- ルーティング
  async function render() {
    const { path, q } = parseHash();
    let res;
    try {
      let m;
      if (path === '/' || path === '') res = await pageHome();
      else if (path === '/matches') res = await pageList(q);
      else if (path === '/new') res = await pageNew(q);
      else if (path === '/review') res = pageReview();
      else if ((m = /^\/match\/(\d+)$/.exec(path))) res = await pageResult(+m[1], q);
      else if ((m = /^\/match\/(\d+)\/detail$/.exec(path))) res = await pageDetail(+m[1], q);
      else if (path === '/ledger') res = await pageLedger(q);
      else if (path === '/layouts') res = await pageLayouts();
      else if ((m = /^\/layout\/(\d+)$/.exec(path))) res = await pageLayoutEdit(+m[1], q);
      else if (path === '/backup') res = await pageBackup();
      else res = { redirect: '/' };
    } catch (e) {
      console.error(e);
      res = { nav: '', title: 'エラー', html: `<div class="msg msg-err">画面を表示できませんでした:${h(e.message)}</div><div><a href="#/" class="btn">照合一覧へ</a></div>` };
    }
    if (res.redirect) { if (res.flash) flash = res.flash; location.hash = res.redirect; return; }
    document.title = res.title + ' - 受領照合';
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === res.nav));
    const f = flash; flash = null;
    $('#view').innerHTML = (f && f.msg ? `<div class="msg msg-ok" role="status">${h(f.msg)}</div>` : '') + (f && f.err ? `<div class="msg msg-err" role="alert">${h(f.err)}</div>` : '') + res.html;
    window.scrollTo(0, 0);
    syncFileType();
  }

  function syncFileType() {
    document.querySelectorAll('form').forEach(f => {
      const ft = f.querySelector('select[name=file_type]');
      if (!ft) return;
      f.querySelectorAll('.js-csv').forEach(el => { el.style.display = ft.value === 'csv' ? '' : 'none'; });
      f.querySelectorAll('.js-excel').forEach(el => { el.style.display = ft.value === 'excel' ? '' : 'none'; });
    });
  }

  // ---------------------------------------------------------------- 操作
  // エラーは画面上部に表示するだけにし、入力中の内容(選んだファイル等)は残す
  function showError(msg) {
    const v = $('#view');
    v.querySelectorAll(':scope > .msg').forEach(e => e.remove());
    const d = document.createElement('div');
    d.className = 'msg msg-err'; d.setAttribute('role', 'alert'); d.textContent = msg;
    v.prepend(d);
    window.scrollTo(0, 0);
  }
  async function guarded(fn) {
    try { await fn(); } catch (e) {
      busy(false);
      if (!(e instanceof RM.ReadError)) console.error(e);
      showError(e instanceof RM.ReadError ? e.message : '処理できませんでした:' + e.message);
    }
  }
  const layoutSettings = fd => ({ name: String(fd.get('name') || ''), file_type: String(fd.get('file_type')), encoding: String(fd.get('encoding')),
    delimiter: String(fd.get('delimiter')), sheet_name: String(fd.get('sheet_name') || ''), header_row: parseInt(fd.get('header_row'), 10), data_start_row: parseInt(fd.get('data_start_row'), 10) });

  const FORMS = {
    'list-filter': async (f, fd) => go('/matches' + qs({ cust: fd.get('cust'), from: fd.get('from'), to: fd.get('to'), unchecked: fd.get('unchecked') })),
    'ledger-filter': async (f, fd) => go('/ledger' + qs({ cust: fd.get('cust'), q: fd.get('q'), dup: fd.get('dup') })),
    'result-filter': async (f, fd) => go(f.dataset.base.slice(1) + qs({ view: f.dataset.view, only_diff: fd.get('only_diff'), only_unc: fd.get('only_unc'), q: fd.get('q') })),
    'new': async (f, fd) => {
      let df, dtt;
      try { df = RM.date(String(fd.get('from')).trim()); dtt = RM.date(String(fd.get('to')).trim()); } catch (_) { throw new RM.ReadError('期間を YYYY/MM/DD で入力してください。'); }
      const parentId = fd.get('parent') ? +fd.get('parent') : null;
      const parent = parentId ? await RM.getMatch(parentId) : null;
      const s = await readFile(f.querySelector('input[name=sales]')), r = await readFile(f.querySelector('input[name=receipt]'));
      if (!s || !r) throw new RM.ReadError('売上データと受領データの両方を選択してください。');
      busy(true, 'ファイルを読み込んでいます…');
      draft = await RM.stage({ dateFrom: df, dateTo: dtt, salesName: s.name, salesBuf: s.buf,
        receiptName: r.name, receiptBuf: r.buf, parentId, onProgress: t => busy(true, t) });
      busy(false);
      go('/review');
    },
    'ledger': async f => {
      const file = await readFile(f.querySelector('input[name=file]'));
      if (!file) throw new RM.ReadError('ファイルを選択してください。');
      if (!confirm('現在の販売台帳をすべて置き換えます。よろしいですか?')) return;
      busy(true, '販売台帳を読み込んでいます…');
      const m = await RM.importLedger(file.buf, file.name, n => busy(true, `販売台帳を読み込んでいます…(${n.toLocaleString()}行)`));
      busy(false);
      go('/ledger', { msg: `販売台帳を取り込みました(有効 ${fAmt(m.loaded_rows)}件、削除区分9 を除外 ${fAmt(m.deleted_rows)}件${m.skipped_rows ? `、コード空欄で除外 ${fAmt(m.skipped_rows)}件` : ''})。` });
    },
    'layout-new': async (f, fd) => {
      const st = layoutSettings(fd), file = await readFile(f.querySelector('input[name=file]'));
      if (!file || !st.name.trim()) throw new RM.ReadError('レイアウト名とサンプルファイルを指定してください。');
      if (!(st.header_row >= 1) || !(st.data_start_row > st.header_row)) throw new RM.ReadError('データ開始行は見出し行より後ろにしてください。');
      st.name = st.name.trim(); st.sheet_name = st.sheet_name.trim();
      const id = await RM.createLayoutFromSample(st, file.name, file.buf);
      go('/layout/' + id, { msg: 'サンプルを読み込みました。各列の役割を設定して保存してください。' });
    },
    'layout-save': async (f, fd) => {
      const id = +f.dataset.id, roles = {}, fmts = {};
      for (const [k, v] of fd.entries()) {
        let m;
        if ((m = /^role_(\d+)$/.exec(k))) roles[+m[1]] = RM.ROLE_LABEL[v] ? String(v) : '';
        if ((m = /^fmt_(\d+)$/.exec(k))) fmts[+m[1]] = String(v);
      }
      const errs = await RM.saveLayout(id, layoutSettings(fd), roles, fmts);
      if (errs.length) flash = { err: errs.join(' / ') }; else flash = { msg: '保存しました。' };
      render();
    },
    'layout-sample': async f => {
      const file = await readFile(f.querySelector('input[name=file]'));
      if (!file) throw new RM.ReadError('ファイルを選択してください。');
      await RM.reloadSample(+f.dataset.id, file.name, file.buf);
      flash = { msg: 'サンプルを読み直しました(同じ列・見出しの役割は引き継いでいます)。' };
      render();
    },
    'assign': async (f, fd) => {
      const cust = code(fd.get('cust'));
      if (!cust) throw new RM.ReadError('販売先コードを入力してください。');
      await RM.assign(cust, String(fd.get('cust_name') || ''), +fd.get('layout_id'));
      flash = { msg: `販売先 ${cust} のレイアウトを設定しました。` };
      render();
    },
    'detail-confirm': async (f, fd) => {
      await RM.setConfirmation(+f.dataset.id, f.dataset.view, f.dataset.key, fd.get('checked') === '1', String(fd.get('comment') || ''));
      flash = { msg: '保存しました。' };
      render();
    },
    'restore': async f => {
      const file = f.querySelector('input[name=file]').files[0];
      if (!file) throw new RM.ReadError('ファイルを選択してください。');
      if (!confirm('現在のデータをすべてバックアップの内容に置き換えます。よろしいですか?')) return;
      busy(true, '復元しています…');
      const at = await RM.importBackup(await file.text());
      busy(false);
      go('/', { msg: `復元しました(バックアップ作成日時 ${(at || '').replace(/-/g, '/')})。` });
    },
  };

  const ACTS = {
    'report': async el => {
      const id = +el.dataset.id, m = await RM.getMatch(id);
      const ok = await saveFile(RM.reportFileName(m), 'xlsx', async () => { busy(true, 'Excelレポートを作成しています…'); return RM.buildReport(id); });
      busy(false);
      if (ok) { flash = { msg: 'Excelレポートを保存しました。' }; render(); }
    },
    'delete-match': async el => { if (confirm('この照合を削除します。よろしいですか?')) { await RM.deleteMatch(+el.dataset.id); flash = { msg: '照合を削除しました。' }; render(); } },
    'review-cancel': async () => { const p = draft && draft.parent_id; draft = null; go(p ? '/match/' + p : '/matches', { msg: '取込を中止しました。' }); },
    'review-confirm': async () => {
      if (!draft) return go('/new');
      busy(true, '照合しています…');
      const id = await RM.confirm(draft);
      draft = null;
      busy(false);
      go('/match/' + id, { msg: '照合しました。' });
    },
    'layout-standard': async el => { if (confirm(`「${el.dataset.name}」を標準レイアウトにします。割当のない得意先はこのレイアウトで読み込みます。`)) { await RM.setStandard(+el.dataset.id); flash = { msg: '標準レイアウトを変更しました。' }; render(); } },
    'layout-delete': async el => {
      if (!confirm(`「${el.dataset.name}」を削除します。よろしいですか?`)) return;
      const e = await RM.deleteLayout(+el.dataset.id);
      flash = e ? { err: e } : { msg: 'レイアウトを削除しました。' };
      render();
    },
    'unassign': async el => { if (confirm(`販売先 ${el.dataset.cust} の割当を解除します。`)) { await RM.unassign(el.dataset.cust); flash = { msg: `販売先 ${el.dataset.cust} の割当を解除しました(標準レイアウトを使用します)。` }; render(); } },
    'backup': async () => {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `受領照合_バックアップ_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
      const ok = await saveFile(name, 'json', async () => { busy(true, 'バックアップを作成しています…'); return RM.exportBackup(); });
      busy(false);
      if (!ok) return;
      await RM.db.put('kv', { k: 'last_backup', at: RM.now() });
      flash = { msg: 'バックアップを保存しました。' };
      render();
    },
  };

  async function saveRow(tr) {
    const cb = tr.querySelector('.js-check'), cm = tr.querySelector('.js-comment');
    try {
      await RM.setConfirmation(+tr.dataset.id, tr.dataset.view, tr.dataset.key, cb.checked, cm.value);
      cm.classList.remove('err'); cm.classList.add('saved'); setTimeout(() => cm.classList.remove('saved'), 1200);
    } catch (e) { cm.classList.add('err'); alert('保存できませんでした:' + e.message); }
  }

  function bind() {
    document.addEventListener('submit', e => {
      const f = e.target.closest('form[data-form]');
      if (!f) return;
      e.preventDefault();
      const fn = FORMS[f.dataset.form];
      if (fn) guarded(() => fn(f, new FormData(f)));
    });
    document.addEventListener('click', e => {
      const clr = e.target.closest('.drop-clear');
      if (clr) { const inp = clr.closest('.dropwrap').querySelector('input[type=file]'); inp.value = ''; setDropState(inp); return; }
      const el = e.target.closest('[data-act]');
      if (el && ACTS[el.dataset.act]) { e.preventDefault(); guarded(() => ACTS[el.dataset.act](el)); }
    });
    document.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('.js-check') || t.matches('.js-comment')) { const tr = t.closest('tr.js-conf'); if (tr) saveRow(tr); }
      if (t.matches('.js-autosubmit')) t.form.requestSubmit();
      if (t.matches('select[name=file_type]')) syncFileType();
      if (t.matches('.drop input[type=file]')) setDropState(t);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.js-comment')) { e.preventDefault(); e.target.blur(); } });
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('.drop'); if (d) { e.preventDefault(); d.classList.add('over'); } }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('.drop'); if (d) { e.preventDefault(); d.classList.remove('over'); } }));
    document.addEventListener('drop', e => {
      const d = e.target.closest && e.target.closest('.drop');
      if (!d) { e.preventDefault(); return; }  // 枠の外にファイルを落としてもブラウザでファイルを開かない
      const inp = d.querySelector('input[type=file]');
      if (e.dataTransfer.files.length) { inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    document.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('hashchange', render);
  }

  async function start() {
    if (!window.indexedDB || !window.DecompressionStream || !window.CompressionStream || !window.TextDecoderStream) {
      $('#view').innerHTML = '<div class="msg msg-err">このブラウザでは動作しません。Microsoft Edge または Google Chrome の最新版で開いてください。</div>';
      return;
    }
    try {
      RM.db = await RM.IdbStore.open();
    } catch (e) {
      $('#view').innerHTML = `<div class="msg msg-err">ブラウザにデータを保存できません(${h(e.message)})。InPrivate / シークレットウィンドウでは使えません。通常のウィンドウで開いてください。</div>`;
      return;
    }
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* noop */ }
    await RM.seed();
    bind();
    render();
  }
  document.addEventListener('DOMContentLoaded', start);
})(globalThis.RM = globalThis.RM || {});
