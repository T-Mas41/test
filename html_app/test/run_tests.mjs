// HTML版ロジックのテスト(Node 22 以上): node html_app/test/run_tests.mjs
// 架空データは Python のテスト用生成器と同じもの(demo_files)を使う。
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsdir = path.join(here, '..', 'src', 'js');
globalThis.RM = {};
for (const f of fs.readdirSync(jsdir).filter(f => /^\d\d_.*\.js$/.test(f) && !f.startsWith('90_')).sort()) {
  vm.runInThisContext(fs.readFileSync(path.join(jsdir, f), 'utf8'), { filename: f });
}
const demo = process.argv[2] || path.join(here, '..', '..', 'demo_files');
const rd = n => fs.readFileSync(path.join(demo, n));
const RM = globalThis.RM;
let passed = 0;
async function test(name, fn) {
  RM.db = await RM.MemStore.open(); RM._cache = null;
  await RM.seed();
  await fn();
  passed++; console.log('ok -', name);
}

async function setupMatch(receiptName = 'デモ_受領データ_標準.xlsx', parentId = null) {
  const d = await RM.stage({ dateFrom: '2026-11-01', dateTo: '2026-11-10', salesName: 's.xlsx', salesBuf: rd('デモ_売上データ.xlsx'),
    receiptName, receiptBuf: rd(receiptName), parentId });
  return [await RM.confirm(d), d];
}

await test('normalize', async () => {
  assert.equal(RM.code('0007227302'), '7227302'); assert.equal(RM.code(7227302), '7227302'); assert.equal(RM.code('000'), '0');
  assert.equal(RM.number('▲1,338'), -1338); assert.equal(RM.number('1,234-'), -1234); assert.equal(RM.number(null), 0);
  assert.equal(RM.toMilli(RM.number(0.3555)), 356); assert.equal(RM.toAmount(-0.5), -1);
  assert.equal(RM.date('20261104'), '2026-11-04'); assert.equal(RM.date('2026/1/5'), '2026-01-05');
  assert.equal(RM.date(20261104), '2026-11-04'); assert.equal(RM.date(46330), '2026-11-04');
  assert.equal(RM.date('2026/11/04', 'YYYY/MM/DD'), '2026-11-04');
  assert.throws(() => RM.date('abc')); assert.throws(() => RM.date('2026/13/45')); assert.throws(() => RM.number('12a'));
});

await test('full flow (same expectations as Python version)', async () => {
  const meta = await RM.importLedger(rd('デモ_販売台帳.xlsx'), '台帳.xlsx');
  assert.equal(meta.loaded_rows, 5); assert.equal(meta.deleted_rows, 1);
  const [id, draft] = await setupMatch();
  assert.equal(draft.stats.receipt.conv_none, 1); assert.equal(draft.stats.receipt.conv_multi, 1);
  assert.equal(draft.cust, '20005525'); assert.equal(draft.cust_name, 'H');
  assert.equal(draft.stats.sales.out_of_period, 1);
  const t = await RM.totals(id);
  assert.equal(t.s_rows, 7); assert.equal(t.r_rows, 6);
  assert.equal(t.s[0], 12720 + 2660 + 40000 + 12400 + 5400 + 3020 - 1338);
  assert.equal(t.r[0], 12720 + 46742 + 12400 + 5400 + 3020 - 1338);
  assert.deepEqual(t.d, [-4082, 0, 35]);
  const slip = Object.fromEntries((await RM.aggregate(id, 'slip')).map(r => [r.k1, r]));
  assert.equal(slip['7227151'].judge, 'diff'); assert.deepEqual(slip['7227151'].d, [2660, 2000, 355]);
  assert.deepEqual(slip['7227188'].d, [-6742, -2000, -320]);
  assert.equal(slip['7227302'].judge, 'ok'); assert.ok(slip['7227302'].k2.includes('売上 2026/11/09 / 受領 2026/11/08'));
  assert.equal(slip['7227290'].judge, 'sonly'); assert.equal(slip['7227295'].judge, 'ronly');
  assert.deepEqual(slip['7227295'].cells, ['7227295', '2026/11/07', '20005561', '松本店']);
  // 店舗名がその伝票の行に無くても、同じ照合内の同じ店舗の行から補う
  {
    const l = await RM.db.get('lines', id);
    for (const x of l.sales.concat(l.receipt)) if (x.order_no === '7227290' || x.order_no === '7227295') x.store_name = '';
    await RM.db.put('lines', l); RM._cache = null;
    const sl = Object.fromEntries((await RM.aggregate(id, 'slip')).map(r => [r.k1, r]));
    assert.equal(sl['7227290'].cells[3], '松本店');
    assert.equal(sl['7227295'].cells[3], '松本店');
  }
  assert.equal(slip['7227400'].judge, 'ok'); assert.equal(slip['7218832'].judge, 'ok');
  const day = Object.fromEntries((await RM.aggregate(id, 'day')).map(r => [r.key[0], r]));
  assert.equal(day['2026-11-08'].judge, 'ronly'); assert.equal(day['2026-11-09'].judge, 'sonly');
  const item = Object.fromEntries((await RM.aggregate(id, 'item')).map(r => [r.key_str, r]));
  assert.equal(item['2026-11-01|[未変換]4958857043977'].judge, 'ronly');
  assert.equal(item['2026-11-01|[未変換]4958857043977'].cells[2], 'FD ﾁｷﾝﾊﾆﾏｽﾄﾙﾃｨｰﾔ');  // 未変換は受領の品名
  assert.equal(item['2026-11-01|000510012'].cells[2], 'チキンハニーマスタードトルティーヤ');
  assert.equal(item['2026-11-06|000283223'].judge, 'diff');                     // 識別コード9桁・複数候補は先頭
  assert.equal(item['2026-11-06|000283223'].judge_label, '差異あり');
  const store = Object.fromEntries((await RM.aggregate(id, 'store')).map(r => [r.key_str, r]));
  assert.equal(store['2026-11-04|20005552'].judge, 'diff');
  assert.deepEqual(store['2026-11-04|20005552'].cells, ['2026/11/04', '20005552', '長野店']);
  // 日別・日別店別・伝票別は金額だけで判定
  assert.equal(RM.compare({ a: 100, q: 1000, w: 0 }, { a: 100, q: 2000, w: 0 }, false).judge, 'ok');
  assert.equal(RM.compare({ a: 100, q: 1000, w: 0 }, { a: 100, q: 2000, w: 500 }, true).judge, 'ok');  // 判定は金額のみ
  assert.deepEqual(new Set((await RM.warnings(id)).map(w => w.conv_status)), new Set(['none', 'multi']));
  const cnt = await RM.counts(id);
  assert.deepEqual(cnt, { day: 4, store: 4, slip: 4, item: 6, warn: 2 });
  const det = await RM.detail(id, 'slip', '7227151');
  assert.equal(det.sales.length, 2); assert.equal(det.receipt.length, 1); assert.equal(det.receipt[0].conv_status, 'ok');

  await RM.setConfirmation(id, 'slip', '7227290', true, '受領漏れ連絡済');
  let m = await RM.getMatch(id);
  assert.equal(m.slip_diff_rows, 4); assert.equal(m.unchecked_rows, 3); assert.equal(m.total_diff_amt, -4082);
  assert.equal((await RM.aggregate(id, 'slip')).find(r => r.k1 === '7227290').comment, '受領漏れ連絡済');

  // Excelレポート(openpyxlでの検証は別スクリプト)
  const blob = await RM.buildReport(id);
  fs.writeFileSync(path.join(process.env.REPORT_OUT || '/tmp', 'report_test.xlsx'), Buffer.from(await blob.arrayBuffer()));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const back = await RM.readXlsx(buf, { sheetName: '伝票別' });
  assert.equal(back[0][1], '販売先:20005525 H');
  assert.equal(back[1][1], '照合期間:2026/11/01 〜 2026/11/10');
  assert.deepEqual(back[3].slice(1), ['相手先注文番号', '取引日付', '店舗コード', '店舗名', '売上 金額', '受領 金額', '差異 金額', '判定']);
  const row = back.find(r => r[1] === '7227290');
  assert.deepEqual(Array.from(row.slice(1, 9)), ['7227290', '2026/11/07', '20005561', '松本店', 5400, undefined, 5400, '自社のみ']);
  const totalRow = back[back.length - 1];
  assert.equal(totalRow[1], '合計(7件)');
  assert.deepEqual(totalRow.slice(5, 8), [74862, 78944, -4082]);
  const itemSheet = await RM.readXlsx(buf, { sheetName: '日別商品別' });
  assert.deepEqual(itemSheet[3].slice(4, 13), ['売上 数量', '売上 重量', '売上 金額', '受領 数量', '受領 重量', '受領 金額', '差異 数量', '差異 重量', '差異 金額']);
  const itemTotal = itemSheet[itemSheet.length - 1];
  assert.deepEqual(itemTotal.slice(4, 13), [50, 10.855, 74862, 50, 10.82, 78944, 0, 0.035, -4082]);
  const summary = await RM.readXlsx(buf, { sheetName: 'サマリ' });
  assert.equal(summary[1][1], '販売先:20005525 H');
  const ci = summary.findIndex(r => r[1] === '売上額(自社)');
  assert.deepEqual(summary[ci + 1].slice(1, 4), [74862, 78944, -4082]);

  // 再取込: 同じ照合を置き換え、確認状況を引き継ぐ
  const [id2] = await setupMatch('デモ_受領データ_標準.xlsx', id);
  assert.equal(id2, id);
  assert.equal((await RM.listMatches()).length, 1);
  assert.equal((await RM.aggregate(id, 'slip')).find(r => r.k1 === '7227290').comment, '受領漏れ連絡済');

  // バックアップ → 復元
  const bk = await (await RM.exportBackup()).text();
  await RM.deleteMatch(id);
  assert.equal((await RM.listMatches()).length, 0);
  await RM.importBackup(bk);
  assert.equal((await RM.listMatches()).length, 1);
  assert.equal((await RM.totals(id)).d[0], -4082);
});

await test('BMS CSV layout via assignment', async () => {
  await RM.importLedger(rd('デモ_販売台帳.xlsx'), 'l.xlsx');
  const bms = (await RM.layouts()).find(l => l.name === '流通BMS 受領CSV');
  await RM.assign('20005525', '', bms.id);
  const [id, d] = await setupMatch('デモ_受領データ_BMS.csv');
  assert.equal(d.layout_name, '流通BMS 受領CSV');
  assert.equal((await RM.totals(id)).r_rows, 6);
  assert.deepEqual((await RM.totals(id)).d, [-4082, 0, 35]);
  assert.match(await RM.deleteLayout(bms.id), /削除できません/);
});

await test('multiple customers in sales data is an error', async () => {
  await assert.rejects(RM.stage({ dateFrom: '2026-11-01', dateTo: '2026-11-10', salesName: 's', salesBuf: rd('デモ_売上データ_複数販売先.xlsx'),
    receiptName: 'r', receiptBuf: rd('デモ_受領データ_標準.xlsx') }), /複数の販売先コード.*20005525 H:8行.*20009999 H:1行/);
});

await test('sales layout check and receipt errors', async () => {
  await assert.rejects(RM.stage({ dateFrom: '2026-11-01', dateTo: '2026-11-10', salesName: 'x', salesBuf: rd('デモ_受領データ_標準.xlsx'),
    receiptName: 'r', receiptBuf: rd('デモ_受領データ_標準.xlsx') }), /売上データのレイアウトが想定と異なります/);
  // 受領に不正な日付の行と合計行を足したファイル
  const blob = await RM.writeXlsx([{ name: 'S', rows: [RM.STANDARD_RECEIPT_HEADERS.map(v => ({ v })),
    Array.from({ length: 45 }, (_, i) => ({ v: { 1: '2026/13/45', 4: '7000001', 13: '2721327000000', 7: 100 }[i] ?? null })),
    Array.from({ length: 45 }, (_, i) => ({ v: i === 7 ? 999999 : null }))] }]);
  const d = await RM.stage({ dateFrom: '2026-11-01', dateTo: '2026-11-10', salesName: 's', salesBuf: rd('デモ_売上データ.xlsx'),
    receiptName: 'r', receiptBuf: new Uint8Array(await blob.arrayBuffer()) });
  assert.equal(d.stats.receipt.error, 1); assert.match(d.errors[0].msg, /日付として読めません/);
  assert.equal(d.stats.receipt.skipped_blank, 1);
});

await test('layout from sample (header on row 3, named sheet)', async () => {
  const blob = await RM.writeXlsx([{ name: '表紙', rows: [[{ v: 'x' }]] }, { name: '明細', rows: [[{ v: 'K社 受領明細' }], [],
    ['納品日', '発注番号', 'JAN', '品名', '数量', '金額'].map(v => ({ v })),
    ['2026/11/04', '7227151', '2721327000000', 'もも', 10, '12,720'].map(v => ({ v }))] }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const id = await RM.createLayoutFromSample({ name: 'K社', file_type: 'excel', encoding: 'cp932', delimiter: ',', sheet_name: '明細', header_row: 3, data_start_row: 4 }, 'k.xlsx', buf);
  const settings = { name: 'K社', file_type: 'excel', encoding: 'cp932', delimiter: ',', sheet_name: '明細', header_row: 3, data_start_row: 4 };
  let errs = await RM.saveLayout(id, settings, { 1: 'tdate', 2: 'order_no' }, {});
  assert.ok(errs.some(e => e.includes('相手先商品コード')));
  errs = await RM.saveLayout(id, settings, { 1: 'tdate', 2: 'order_no', 3: 'partner_code', 4: 'name', 5: 'qty', 6: 'amt' }, {});
  assert.deepEqual(errs, []);
  const pv = RM.previewLayout(await RM.db.get('layouts', id));
  assert.equal(pv[0].tdate, '2026/11/04'); assert.equal(pv[0].amt, '12,720');
});

console.log(`\n${passed} passed`);
