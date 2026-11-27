/* Excel(.xlsx)/CSV の読込と .xlsx の書出。外部ライブラリなし(ブラウザ標準の圧縮APIのみ使用)。 */
(function (RM) {
  'use strict';

  class ReadError extends Error {}
  RM.ReadError = ReadError;

  // ---------------------------------------------------------------- ZIP
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  RM.isZip = isZip;

  function zipEntries(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ReadError('Excelファイルの形式が正しくありません。');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const dec = new TextDecoder('utf-8');
    const map = new Map();
    for (let i = 0; i < count; i++) {
      if (u32(bytes, p) !== 0x02014b50) throw new ReadError('Excelファイルの形式が正しくありません。');
      const method = u16(bytes, p + 10), csize = u32(bytes, p + 20), nlen = u16(bytes, p + 28);
      const elen = u16(bytes, p + 30), clen = u16(bytes, p + 32), loff = u32(bytes, p + 42);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      map.set(name.toLowerCase(), { name, method, csize, loff });
      p += 46 + nlen + elen + clen;
    }
    return map;
  }

  function entryStream(bytes, e) {
    const start = e.loff + 30 + u16(bytes, e.loff + 26) + u16(bytes, e.loff + 28);
    const data = bytes.subarray(start, start + e.csize);
    const src = new Blob([data]).stream();
    if (e.method === 0) return src;
    if (e.method === 8) return src.pipeThrough(new DecompressionStream('deflate-raw'));
    throw new ReadError('対応していない圧縮形式です。');
  }

  async function entryText(bytes, entries, name) {
    const e = entries.get(name.toLowerCase());
    if (!e) return null;
    return await new Response(entryStream(bytes, e)).text();
  }

  // ---------------------------------------------------------------- XML ヘルパー
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, g) => {
      if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
      return ENT[g] !== undefined ? ENT[g] : m;
    }).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function attr(s, name) {
    const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s);
    return m ? unesc(m[1]) : null;
  }
  // <si> / <is> の文字列(ふりがな <rPh> は除く)
  function richText(inner) {
    inner = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
    let m;
    while ((m = re.exec(inner))) out += m[1] ? unesc(m[1]) : '';
    return out;
  }

  function colIndex(ref) {  // "AB12" -> 28
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n;
  }
  function colName(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  RM.colName = colName;

  const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  function dateStyles(stylesXml) {
    const isDate = [];
    if (!stylesXml) return isDate;
    const custom = new Map();
    const nf = /<numFmt\b([^>]*)\/?>/g;
    let m;
    while ((m = nf.exec(stylesXml))) {
      const id = +attr(m[1], 'numFmtId');
      const code = (attr(m[1], 'formatCode') || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').toLowerCase();
      custom.set(id, /[ymd]/.test(code) && !/^[#0.,\s%]*$/.test(code));
    }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (xfs) {
      const re = /<xf\b([^>]*?)\/?>/g;
      while ((m = re.exec(xfs[1]))) {
        const id = +(attr(m[1], 'numFmtId') || 0);
        isDate.push(custom.has(id) ? custom.get(id) : BUILTIN_DATE.has(id));
      }
    }
    return isDate;
  }

  function serialToYmd(n) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0');
  }

  /**
   * .xlsx を読み、行の配列を返す。各行は列番号(1始まり)をインデックスとする疎な配列。
   * opts.sheetName: シート名(空なら先頭) / opts.maxRow: この行番号まで読む / opts.cols: 保持する列番号 / opts.onProgress(行番号)
   */
  async function readXlsx(buffer, opts = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!isZip(bytes)) throw new ReadError('Excel(.xlsx)ファイルではありません。古い形式(.xls)の場合は .xlsx で保存し直してください。');
    const entries = zipEntries(bytes);
    const wb = await entryText(bytes, entries, 'xl/workbook.xml');
    const rels = await entryText(bytes, entries, 'xl/_rels/workbook.xml.rels');
    if (!wb || !rels) throw new ReadError('Excelファイルの形式が正しくありません。');
    const sheets = [];
    let m;
    const sre = /<sheet\b([^>]*)\/?>/g;
    while ((m = sre.exec(wb))) sheets.push({ name: attr(m[1], 'name'), rid: attr(m[1], 'r:id') });
    if (!sheets.length) throw new ReadError('シートがありません。');
    let sheet = sheets[0];
    if (opts.sheetName) {
      sheet = sheets.find(s => s.name === opts.sheetName);
      if (!sheet) throw new ReadError(`シート「${opts.sheetName}」がありません(シート: ${sheets.map(s => s.name).join('、')})`);
    }
    let target = null;
    const rre = /<Relationship\b([^>]*)\/?>/g;
    while ((m = rre.exec(rels))) if (attr(m[1], 'Id') === sheet.rid) target = attr(m[1], 'Target');
    if (!target) throw new ReadError('シートが見つかりません。');
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');

    const shared = [];
    const ss = await entryText(bytes, entries, 'xl/sharedStrings.xml');
    if (ss) {
      const re = /<si>([\s\S]*?)<\/si>|<si\s*\/>/g;
      while ((m = re.exec(ss))) shared.push(m[1] ? richText(m[1]) : '');
    }
    const isDate = dateStyles(await entryText(bytes, entries, 'xl/styles.xml'));

    const e = entries.get(path.toLowerCase());
    if (!e) throw new ReadError('シートのデータが見つかりません。');
    const rows = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const maxRow = opts.maxRow || Infinity;
    const keep = opts.cols ? new Set(opts.cols) : null;  // 指定した列だけ保持(メモリ節約)。他の列は「値がある」印だけ残す
    let seqRow = 0, done = false;

    function parseRow(rowXml) {
      const head = /^<row\b([^>]*)>/.exec(rowXml);
      const rAttr = head ? attr(head[1], 'r') : null;
      const rowNo = rAttr ? +rAttr : seqRow + 1;
      seqRow = rowNo;
      if (rowNo > maxRow) { done = true; return; }
      const row = [];
      let seqCol = 0, cm;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rowXml))) {
        const a = cm[1];
        const ref = attr(a, 'r');
        const col = ref ? colIndex(ref) : seqCol + 1;
        seqCol = col;
        const inner = cm[2];
        if (inner === undefined) continue;
        if (keep && !keep.has(col)) { if (/<v>[^<]|<t[^>]*>[^<]/.test(inner)) row.any = true; continue; }
        const t = attr(a, 't');
        let v = null;
        if (t === 'inlineStr') {
          const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
          v = is ? richText(is[1]) : '';
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (!vm) continue;
          const raw = vm[1];
          if (t === 's') v = shared[+raw] !== undefined ? shared[+raw] : '';
          else if (t === 'str' || t === 'e') v = unesc(raw);
          else if (t === 'b') v = raw === '1';
          else if (t === 'd') v = unesc(raw).slice(0, 10).replace(/-/g, '/');
          else {
            const n = Number(raw);
            const s = attr(a, 's');
            v = (s !== null && isDate[+s]) ? serialToYmd(n) : n;
          }
        }
        row[col] = v;
      }
      rows[rowNo - 1] = row;
      if (opts.onProgress && rowNo % 5000 === 0) opts.onProgress(rowNo);
    }

    const reader = entryStream(bytes, e).pipeThrough(new TextDecoderStream('utf-8')).getReader();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let start = buf.indexOf('<row');
      let last = buf.lastIndexOf('</row>');
      if (start >= 0 && last > start) {
        const chunk = buf.slice(start, last + 6);
        buf = buf.slice(last + 6);
        const parts = chunk.split('</row>');
        for (const pr of parts) {
          const i = pr.indexOf('<row');
          if (i >= 0) parseRow(pr.slice(i));
          if (done) break;
        }
      } else if (start < 0 && buf.length > 1 << 20) {
        buf = buf.slice(-64);
      }
      if (done) { try { await reader.cancel(); } catch (_) { /* noop */ } break; }
    }
    if (!done) {
      const i = buf.indexOf('<row');
      if (i >= 0 && buf.indexOf('</row>', i) > 0) parseRow(buf.slice(i, buf.indexOf('</row>', i)));
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }
  RM.readXlsx = readXlsx;

  // ---------------------------------------------------------------- CSV
  const ENC_LABEL = { 'cp932': 'shift_jis', 'utf-8': 'utf-8', 'utf-8-sig': 'utf-8' };
  function readCsv(buffer, encoding, delimiter, maxRow) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (isZip(bytes)) throw new ReadError('CSVを指定していますが、Excelファイルが選択されています。');
    let text;
    try {
      text = new TextDecoder(ENC_LABEL[encoding] || encoding, { fatal: true }).decode(bytes);
    } catch (e) {
      throw new ReadError(`文字コード ${RM.ENCODINGS[encoding] || encoding} として読めません。レイアウトの文字コード設定を確認してください。`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [''], i = 0, q = false, col = 0;
    const n = text.length, d = delimiter || ',';
    const lim = maxRow || Infinity;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { row[col] += '"'; i += 2; continue; } q = false; i++; continue; }
        row[col] += c; i++; continue;
      }
      if (c === '"' && row[col] === '') { q = true; i++; continue; }
      if (c === d) { row.push(''); col++; i++; continue; }
      if (c === '\r' || c === '\n') {
        rows.push(row); if (rows.length >= lim) break;
        row = ['']; col = 0;
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      row[col] += c; i++;
    }
    if (rows.length < lim && !(row.length === 1 && row[0] === '')) rows.push(row);
    // 列番号(1始まり)に揃える
    return rows.map(r => { const a = [undefined]; for (const v of r) a.push(v); return a; });
  }
  RM.readCsv = readCsv;

  /** ファイル種別に応じて読む。行は 1始まりの列番号で参照する。 */
  async function readRows(buffer, fileType, opts = {}) {
    if (fileType === 'excel') return readXlsx(buffer, opts);
    return readCsv(buffer, opts.encoding || 'cp932', opts.delimiter || ',', opts.maxRow);
  }
  RM.readRows = readRows;

  // ---------------------------------------------------------------- .xlsx 書出
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  async function deflate(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function zip(files) {  // files: [{name, data(Uint8Array)}]
    const enc = new TextEncoder();
    const parts = [], cd = [];
    let off = 0;
    const now = new Date();
    const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    for (const f of files) {
      const name = enc.encode(f.name);
      const comp = await deflate(f.data);
      const crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
      lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, comp.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, comp);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 8, true); ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, comp.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, off, true);
      cd.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + comp.length;
    }
    const cdSize = cd.reduce((a, b) => a + b.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
    return new Blob([...parts, ...cd, new Uint8Array(eo.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  // スタイル: fill 0なし 1黄 2青 3赤 4見出し(紺) / fmt 0なし 1金額 2数量 3重量 / bold
  const FILLS = ['', 'FFF2B3', 'D6E6FA', 'F9D4D4', '17324D'];  // 見出しの色は fillId 6
  const FMTS = [0, 164, 165, 166];
  // kind 0通常(罫線) 1見出し 2太字 3タイトル 4罫線なし 5大きな金額 6大きな金額(赤背景) 7大きな金額(緑背景)
  //      8合計行(fmt 0:文字 1:金額 2:数量 3:重量) 9販売先(太字16pt) 10照合期間(太字13pt)
  function styleId(fill, fmt, kind) {
    if (kind === 8) return 23 + fmt;
    if (kind === 9) return 27;
    if (kind === 10) return 28;
    if (kind >= 11 && kind <= 16) return 18 + kind;  // 11:売上見出し 12:受領見出し 13:差異見出し 14:枠付き値(16pt) 15:枠付き値(14pt) 16:項目名(灰背景)
    if (kind >= 5) return 15 + kind;
    if (kind === 1) return 1;
    if (kind === 2) return 2;
    if (kind === 3) return 3;
    if (kind === 4) return 0;
    return 4 + fill * 4 + fmt;
  }
  RM.xlStyle = styleId;
  function stylesXml() {
    let xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
    for (let f = 0; f < 4; f++) for (let n = 0; n < 4; n++) {
      xfs += `<xf numFmtId="${FMTS[n]}" fontId="0" fillId="${f === 0 ? 0 : f + 1}" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>`;
    }
    // 20: 大きな金額 21: 大きな金額(赤背景) 22: 大きな金額(緑背景)
    xfs += '<xf numFmtId="164" fontId="4" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="164" fontId="5" fillId="7" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="164" fontId="4" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>';
    // 23-26: 合計行(文字/金額/数量/重量) 27: 販売先 28: 照合期間
    xfs += [0, 164, 165, 166].map(n => `<xf numFmtId="${n}" fontId="2" fillId="9" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>`).join('') +
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
    // 29-31: 売上・受領・差異の見出し
    xfs += [10, 11, 12].map(f => `<xf numFmtId="0" fontId="1" fillId="${f}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`).join('');
    // 32: 枠付きの値(太字16pt) 33: 枠付きの値(太字14pt) 34: 項目名(太字・灰背景)
    xfs += '<xf numFmtId="0" fontId="4" fillId="9" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="7" fillId="9" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="13" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>';
    const fills = '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      FILLS.slice(1).map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0;[Red]\\-#,##0"/><numFmt numFmtId="165" formatCode="#,##0.###;[Red]\\-#,##0.###"/><numFmt numFmtId="166" formatCode="#,##0.000;[Red]\\-#,##0.000"/></numFmts>' +
      '<fonts count="8"><font><sz val="11"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="11"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="14"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="16"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="16"/><color rgb="FFB42318"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="13"/><color rgb="FF5B3FD6"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="14"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font></fonts>' +
      `<fills count="14">${fills}<fill><patternFill patternType="solid"><fgColor rgb="FF6D4CE5"/><bgColor indexed="64"/></patternFill></fill>` +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFDEDED"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F6EE"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF1EDFF"/><bgColor indexed="64"/></patternFill></fill>' +
      ['3B5CC4', 'C2611F', '4A4368', 'F4F2FA'].map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('') + '</fills>' +
      '<borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFD0D5DB"/></left><right style="thin"><color rgb="FFD0D5DB"/></right><top style="thin"><color rgb="FFD0D5DB"/></top><bottom style="thin"><color rgb="FFD0D5DB"/></bottom><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFD0D5DB"/></left><right style="thin"><color rgb="FFD0D5DB"/></right><top style="double"><color rgb="FF6D4CE5"/></top><bottom style="thin"><color rgb="FFD0D5DB"/></bottom><diagonal/></border>' +
      '<border><left style="medium"><color rgb="FF6D4CE5"/></left><right style="medium"><color rgb="FF6D4CE5"/></right><top style="medium"><color rgb="FF6D4CE5"/></top><bottom style="medium"><color rgb="FF6D4CE5"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${4 + 16 + 3 + 6 + 3 + 3}">${xfs}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  /**
   * sheets: [{name, widths:[..], rows:[[{v, s}...]], freeze:bool, filter:bool}]
   * v: 文字列/数値/null、s: スタイル番号
   */
  async function writeXlsx(sheets) {
    const enc = new TextEncoder();
    const files = [];
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    sheets.forEach((sh, si) => {
      const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<worksheet ${ns}>`,
        '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'];  // 印刷時は用紙の幅に合わせる
      const nrows = sh.rows.length, ncols = Math.max(1, ...sh.rows.map(r => r.length)), fr = sh.freezeRows || 1;
      out.push(`<dimension ref="A1:${colName(ncols)}${Math.max(1, nrows)}"/>`);
      out.push('<sheetViews><sheetView workbookViewId="0"' + (si === 0 ? ' tabSelected="1"' : '') + '>' +
        (sh.freeze ? `<pane ySplit="${fr}" topLeftCell="A${fr + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${fr + 1}" sqref="A${fr + 1}"/>` : '') +
        '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>');
      if (sh.widths && sh.widths.length) out.push('<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>');
      out.push('<sheetData>');
      for (let r = 0; r < nrows; r++) {
        const row = sh.rows[r];
        const ht = sh.heights && sh.heights[r];
        let x = `<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>`;
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (!cell) continue;
          const ref = colName(c + 1) + (r + 1);
          const s = cell.s ? ` s="${cell.s}"` : '';
          const v = cell.v;
          if (v === null || v === undefined || v === '') x += `<c r="${ref}"${s}/>`;
          else if (typeof v === 'number' && isFinite(v)) x += `<c r="${ref}"${s}><v>${v}</v></c>`;
          else x += `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
        }
        out.push(x + '</row>');
      }
      out.push('</sheetData>');
      if (sh.filter && nrows > 0) out.push(`<autoFilter ref="${sh.filterRef || `A1:${colName(ncols)}${nrows}`}"/>`);
      if (sh.merges && sh.merges.length) out.push(`<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
      out.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
        '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>');  // A4横・幅1ページ
      files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: enc.encode(out.join('')) });
    });
    const sheetList = sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
    const absRef = ref => ref.split(':').map(x => x.replace(/^([A-Z]+)(\d+)$/, (m, c, r) => '$' + c + '$' + r)).join(':');
    const defNames = sheets.map((s, i) => s.filter && s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(s.name)}'!${absRef(s.filterRef || `A1:${colName(Math.max(1, ...s.rows.map(r => r.length)))}${s.rows.length}`)}</definedName>` : '').join('');
    files.unshift(
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns}><bookViews><workbookView/></bookViews><sheets>${sheetList}</sheets>${defNames ? '<definedNames>' + defNames + '</definedNames>' : ''}</workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
      { name: 'xl/styles.xml', data: enc.encode(stylesXml()) },
    );
    return zip(files);
  }
  RM.writeXlsx = writeXlsx;
})(globalThis.RM = globalThis.RM || {});
