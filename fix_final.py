# -*- coding: utf-8 -*-
with open('d:/game/mytemple/src-tauri/src/app.rs', encoding='utf-8') as f:
    content = f.read()

SQ = chr(39)
DQ = chr(34)
BS = chr(92)

lines = content.split(chr(10))
new_lines = []
for line in lines:
    if 'trim_matches' in line and ('l[..' in line or 'l[colon' in line):
        indent = line[:len(line) - len(line.lstrip())]
        if 'l[..' in line:
            new_line = indent + 'let key = l[..colon].trim().trim_matches(' + DQ + SQ + DQ + ').trim_matches(' + DQ + BS + DQ + DQ + ');'
        else:
            new_line = indent + 'let val = l[colon+1..].trim().trim_matches(' + DQ + SQ + DQ + ').trim_matches(' + DQ + BS + DQ + DQ + ');'
        print('OLD:', repr(line.strip()[:80]))
        print('NEW:', repr(new_line.strip()[:80]))
        new_lines.append(new_line)
    else:
        new_lines.append(line)

new_content = chr(10).join(new_lines)
with open('d:/game/mytemple/src-tauri/src/app.rs', 'w', encoding='utf-8') as f:
    f.write(new_content)
print('Done. Size:', len(new_content))
