import re, sys, json
DEFAULT_PATTERN = (r'^(?P<label>(?:参加者|話者|発言者|スピーカー|Speaker|speaker)\s*\d+)'
                   r'(?P<rest>(?:[ \t　]+\d{1,2}:\d{2}(?::\d{2})?)?[ \t　]*)$')

def read(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return f.read()

def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)

def lines_keep(text):
    return text.splitlines(keepends=True)

def split_eol(line):
    body = line.rstrip('\r\n')
    return body, line[len(body):]

def arg_pattern(argv):
    if '--pattern' in argv:
        i = argv.index('--pattern'); p = argv[i+1]; del argv[i:i+2]
        return re.compile(p)
    return re.compile(DEFAULT_PATTERN)
