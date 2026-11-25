#!/usr/bin/env python3
"""使い方: build_minutes.py minutes.json 出力.docx"""
import sys, json
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FONT = 'メイリオ'
def setfont(run, size=11, bold=False):
    run.font.name = FONT; run.font.size = Pt(size); run.bold = bold
    run._element.rPr.rFonts.set(qn('w:eastAsia'), FONT)

def para(doc, text, size=11, bold=False, style=None):
    p = doc.add_paragraph(style=style); setfont(p.add_run(text), size, bold); return p

def field(run, instr):
    for t, txt in (('begin', None), (None, instr), ('end', None)):
        if t:
            e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), t)
        else:
            e = OxmlElement('w:instrText'); e.set(qn('xml:space'), 'preserve'); e.text = txt
        run._r.append(e)

def shade(cell, color='D9E2F3'):
    pr = cell._tc.get_or_add_tcPr(); s = OxmlElement('w:shd')
    s.set(qn('w:val'), 'clear'); s.set(qn('w:fill'), color); pr.append(s)

def table(doc, header, rows, widths_cm, header_col=False):
    t = doc.add_table(rows=0, cols=len(widths_cm)); t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER; t.autofit = False
    def addrow(vals, head=False):
        cells = t.add_row().cells
        for i, v in enumerate(vals):
            cells[i].width = Cm(widths_cm[i]); cells[i].text = ''
            setfont(cells[i].paragraphs[0].add_run(str(v)), 10.5 if not head else 10.5, head or (header_col and i == 0))
            if head or (header_col and i == 0): shade(cells[i])
    if header: addrow(header, True)
    for r in rows: addrow(r)
    return t

def main(src, dst):
    d = json.load(open(src, encoding='utf-8'))
    doc = Document()
    sec = doc.sections[0]; sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2); sec.top_margin = sec.bottom_margin = Cm(2)
    st = doc.styles['Normal']; st.font.name = FONT; st.font.size = Pt(11)
    st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)
    hp = sec.header.paragraphs[0]; hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = hp.add_run(); setfont(r, 9); field(r, 'PAGE')
    r = hp.add_run(' / '); setfont(r, 9)
    r = hp.add_run(); setfont(r, 9); field(r, 'NUMPAGES')
    W = 17.0
    para(doc, '議事録', 16, True).alignment = WD_ALIGN_PARAGRAPH.CENTER
    para(doc, '【基本情報】', 12, True)
    b = d['basic']
    table(doc, None, [['開催日時', b.get('date', '要確認')], ['会議名', b.get('title', '要確認')],
          ['開催形式', b.get('format', '要確認')], ['出席者', b.get('attendees', '要確認')],
          ['欠席者', b.get('absent', '要確認')]], [3.5, W-3.5], header_col=True)
    para(doc, '1. 会議全体の概要', 12, True)
    for l in d.get('overview', []): para(doc, l)
    para(doc, '2. 前回宿題に対する進捗', 12, True)
    pt = d.get('prev_tasks')
    if not pt: para(doc, '前回宿題無し')
    else:
        table(doc, ['連番', '担当者', '対応事項', '期限', '進捗'],
              [[x.get('no', ''), x.get('owner', '要確認'), x.get('task', ''), x.get('due', '未定'), x.get('progress', '要確認')] for x in pt],
              [1.2, 2.6, 7.2, 2.6, 3.4])
    para(doc, '3. 議事内容', 12, True)
    for a in d.get('agenda', []):
        para(doc, '■ ' + a['title'], 11, True)
        for it in a.get('items', []): para(doc, it, style='List Bullet')
    para(doc, '4. 決定事項', 12, True)
    for x in d.get('decisions', []) or ['なし']: para(doc, x, style='List Bullet')
    para(doc, '5. 次回までの宿題', 12, True)
    ts = d.get('tasks', [])
    table(doc, ['連番', '担当者', '対応事項', '期限'],
          [[x.get('no', f'{i+1:02d}'), x.get('owner', '要確認'), x.get('task', ''), x.get('due', '未定')] for i, x in enumerate(ts)] or [['', '', '', '']],
          [1.2, 3.0, 9.8, 3.0])
    para(doc, '6. 次回会議予定', 12, True)
    para(doc, d.get('next_meeting', '未定'))
    doc.add_paragraph()
    para(doc, d.get('note') or '※本議事録は文字起こしデータを基に作成しています。固有名詞・時刻・担当者・期限等は要確認です。', 9)
    doc.save(dst); print('出力:', dst)
main(sys.argv[1], sys.argv[2])
