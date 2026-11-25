#!/usr/bin/env python3
"""固有名詞の候補(カタカナ語・英字語・「株式会社」等を含む語)を頻度付きで列挙。発言者ラベル行は除外。AIが全文確認で補完する。"""
import sys, re, collections
from common import *
argv = sys.argv[1:]; pat = arg_pattern(argv)
c = collections.Counter()
rx = re.compile(r'[ァ-ヴー]{3,}|[A-Za-z][A-Za-z0-9\-_.]{1,}|(?:株式会社|有限会社)\S{1,12}|\S{1,12}(?:株式会社|部|課|様|さん|氏)')
for ln in lines_keep(read(argv[0])):
    b, _ = split_eol(ln)
    if pat.match(b): continue
    c.update(rx.findall(b))
for w, n in c.most_common(300): print(f'{n}\t{w}')
