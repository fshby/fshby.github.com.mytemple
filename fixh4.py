# -*- coding: utf-8 -*-
import base64
BS = chr(92)
H = chr(35)
LB = chr(91)
DQ = chr(34)

with open('d:/game/mytemple/h_chunk4.b64') as f:
    content = base64.b64decode(f.read().strip()).decode('utf-8')

lines = content.split(chr(10))
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith(BS + 'cfg(target_os'):
        # Pattern: \cfg(target_os = 'X')]
        # Fix to: #[cfg(target_os = 'X')]
        new_stripped = H + LB + stripped[1:]
        # Ensure closing paren + bracket
        new_stripped = new_stripped.rstrip()
        if not new_stripped.endswith(')]'):
            new_stripped = new_stripped.rstrip(']') + ')]'
        lines[i] = line[:len(line)-len(line.lstrip())] + new_stripped
    elif stripped.startswith(BS + 'cfg(all'):
        new_stripped = H + LB + stripped[1:]
        new_stripped = new_stripped.rstrip()
        if not new_stripped.endswith(')]'):
            new_stripped = new_stripped.rstrip(']') + ')]'
        lines[i] = line[:len(line)-len(line.lstrip())] + new_stripped

content = chr(10).join(lines)
encoded = base64.b64encode(content.encode('utf-8')).decode('ascii')
with open('d:/game/mytemple/h_chunk4.b64', 'w') as f:
    f.write(encoded)
print('Fixed chunk 4')
for line in content.split(chr(10)):
    if 'cfg' in line:
        print(repr(line))
