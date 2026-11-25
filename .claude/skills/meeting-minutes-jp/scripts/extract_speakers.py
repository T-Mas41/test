#!/usr/bin/env python3
"""発言者ラベルを抽出し、発言数・初出時刻・抜粋をJSONで出力。"""
import sys, re, json
from common import *
argv = sys.argv[1:]; pat = arg_pattern(argv)
text = read(argv[0]); res = {}; cur = None
for ln in lines_keep(text):
    b, _ = split_eol(ln); m = pat.match(b)
    if m:
        cur = m.group('label'); d = res.setdefault(cur, {'count':0,'first_time':None,'excerpts':[]})
        d['count'] += 1
        t = re.search(r'\d{1,2}:\d{2}(?::\d{2})?', m.groupdict().get('rest') or '')
        if t and not d['first_time']: d['first_time'] = t.group(0)
    elif cur and b.strip() and len(res[cur]['excerpts']) < 3 and len(b) > 8:
        res[cur]['excerpts'].append(b.strip()[:120])
print(json.dumps(res, ensure_ascii=False, indent=2))
