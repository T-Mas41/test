#!/usr/bin/env python3
"""使い方: apply_speakers.py 入力.txt map.json [--pattern RE]
ラベル行のラベル部分のみ置換し、ラベル以外が不変であることを検証して出力する。"""
import sys, os, json
from common import *
argv = sys.argv[1:]; pat = arg_pattern(argv)
src, mp = argv[0], json.load(open(argv[1], encoding='utf-8'))
orig = lines_keep(read(src)); out = []; n = 0; used = set()
for ln in orig:
    b, eol = split_eol(ln); m = pat.match(b)
    if m and m.group('label') in mp and mp[m.group('label')]:
        s, e = m.span('label'); b = b[:s] + mp[m.group('label')] + b[e:]; used.add(m.group('label'))
    out.append(b + eol)
# 検証
ok = True; msgs = []
if len(out) != len(orig): ok = False; msgs.append('行数不一致')
labels_o = [i for i, l in enumerate(orig) if pat.match(split_eol(l)[0])]
labels_n = [i for i, l in enumerate(out) if i in set(labels_o)]
for i, (a, b) in enumerate(zip(orig, out)):
    if i in set(labels_o): continue
    if a != b: ok = False; msgs.append(f'ラベル行以外が変化: {i+1}行目')
left = {pat.match(split_eol(out[i])[0]).group('label') for i in labels_o if pat.match(split_eol(out[i])[0])}
miss = [k for k, v in mp.items() if v and k in left]
if miss: ok = False; msgs.append(f'置換漏れ: {miss}')
for i in labels_o:  # タイムスタンプ維持
    a, b = split_eol(orig[i])[0], split_eol(out[i])[0]; m = pat.match(a)
    if not b.endswith(m.group('rest')): ok = False; msgs.append(f'時刻/空白変化: {i+1}行目')
unk = [k for k in {pat.match(split_eol(orig[i])[0]).group('label') for i in labels_o} if k not in used]
print(f'発言数: {len(labels_o)} / 総行数: {len(orig)}')
print('置換した発言者:', {k: mp[k] for k in used})
print('未変更の発言者(元の識別名を維持):', unk)
print('検証結果:', 'OK（ラベル以外は完全一致）' if ok else 'NG ' + '; '.join(msgs[:10]))
if ok:
    base, _ = os.path.splitext(src); dst = base + '_発言者名修正版.txt'
    write(dst, ''.join(out)); print('出力:', dst)
else:
    sys.exit(1)
