/* 取込値の正規化(コード・数値・日付)と表示書式 */
(function (RM) {
  'use strict';
  const MINUS = ['▲', '△', '−', '－'];
  RM.ENCODINGS = { 'cp932': 'Shift_JIS(CP932)', 'utf-8': 'UTF-8', 'utf-8-sig': 'UTF-8(BOM付)' };
  RM.DELIMITERS = { ',': 'カンマ', '\t': 'タブ' };
  RM.DATE_FORMATS = { '': '自動判別', 'YYYYMMDD': 'YYYYMMDD', 'YYYY/MM/DD': 'YYYY/MM/DD', 'YYYY-MM-DD': 'YYYY-MM-DD' };

  function text(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v).replace(/　/g, ' ').trim();
  }
  function code(v) {
    const s = text(v).normalize('NFKC').trim();
    if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';
    return s;
  }
  const isBlank = v => text(v) === '';

  function number(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') throw new Error('数値ではありません');
    if (typeof v === 'number') return v;
    let s = String(v).normalize('NFKC').trim();
    if (s === '' || /^[-_‐‑–—―ー*・.]+$/.test(s)) return 0;  // 空欄を表す記号(_ - * など)は0
    let neg = false;
    for (const m of MINUS) if (s.startsWith(m)) { neg = true; s = s.slice(m.length); }
    s = s.replace(/,/g, '').replace(/円/g, '').replace(/\s/g, '');
    if (s.length > 1 && s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error('数値として読めません: ' + String(v).slice(0, 20));
    const n = Number(s);
    return neg ? -n : n;
  }
  const rhu = x => (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) + 0.5 + 1e-9);
  const toAmount = n => rhu(n) || 0;          // 金額は整数(円)で比較
  const toMilli = n => rhu(n * 1000) || 0;    // 数量・重量は小数第3位まで(×1000の整数)

  function ymd(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const FMT_RE = {
    'YYYYMMDD': /^(\d{4})(\d{2})(\d{2})$/,
    'YYYY/MM/DD': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
    'YYYY-MM-DD': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  };
  function date(v, fmt) {
    if (typeof v === 'number' && isFinite(v)) {
      const n = Math.trunc(v);
      if (n >= 19000101 && n <= 29991231) v = String(n);
      else if (n >= 1 && n < 2958466) {
        const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
        return d.toISOString().slice(0, 10);
      }
    }
    const s = text(v).normalize('NFKC');
    if (!s) throw new Error('日付が空欄です');
    let m = null;
    if (fmt && FMT_RE[fmt]) m = FMT_RE[fmt].exec(s.split(' ')[0]);
    else m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) || /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(s);
    const r = m && ymd(+m[1], +m[2], +m[3]);
    if (!r) throw new Error('日付として読めません: ' + s.slice(0, 20));
    return r;
  }
  const fmtDate = iso => (iso ? iso.replace(/-/g, '/') : '');

  const fAmt = n => (n === null || n === undefined ? '' : n.toLocaleString('en-US'));
  const fQty = m => (m === null || m === undefined ? '' : (m / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 }));
  const fWt = m => (m === null || m === undefined ? '' : (m / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
  const signed = (fn, n) => (n > 0 ? '+' : '') + fn(n);

  Object.assign(RM, { text, code, isBlank, number, toAmount, toMilli, date, fmtDate, fAmt, fQty, fWt, signed });
})(globalThis.RM = globalThis.RM || {});
