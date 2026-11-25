#!/usr/bin/env python3
"""使い方: apply_terms.py 入力.txt terms.json [--pattern RE]  (terms.json: {"誤":"正"})
発言者ラベル行は対象外。語ごとの置換件数を報告。出力: 元名_固有名詞修正版.txt"""
import sys, os, json
from common import *
argv = sys.argv[1:]; pat = arg_pattern(argv)
src, tm = argv[0], json.load(open(argv[1], encoding='utf-8'))
cnt = {k: 0 for k in tm}; out = []
for ln in lines_keep(read(src)):
    b, eol = split_eol(ln)
    if not pat.match(b):
        for k, v in sorted(tm.items(), key=lambda kv: -len(kv[0])):
            cnt[k] += b.count(k); b = b.replace(k, v)
    out.append(b + eol)
base, ext = os.path.splitext(src)
base = base.replace('_発言者名修正版', '')
dst = base + '_固有名詞修正版.txt'; write(dst, ''.join(out))
for k, n in cnt.items(): print(f'{k} → {tm[k]}: {n}件' + ('  ※該当なし' if n == 0 else ''))
print('出力:', dst)
