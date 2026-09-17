# -*- coding: utf-8 -*-
import base64, os

def load_chunk(idx):
    path = 'd:/game/mytemple/chunk_' + str(idx).zfill(2) + '.b64'
    if not os.path.exists(path):
        return None
    with open(path) as f:
        encoded = f.read().strip()
    return base64.b64decode(encoded).decode('utf-8')

chunks = []
i = 1
while True:
    c = load_chunk(i)
    if c is None:
        break
    chunks.append(c)
    print('Loaded chunk', i, ':', len(c), 'chars')
    i += 1

print('Total chunks:', len(chunks))

with open('d:/game/mytemple/src-tauri/src/app.rs', encoding='utf-8') as f:
    content = f.read()

marker = '// ========== '
marker_idx = content.find(marker)
print('Marker at:', marker_idx)

search_region = content[:marker_idx]
lines = search_region.split(chr(10))

impl_close_idx = None
for j in range(len(lines)-1, -1, -1):
    stripped = lines[j].strip()
    if stripped == '}':
        impl_close_idx = j
        break

print('impl_close_idx:', impl_close_idx)

if impl_close_idx is not None:
    close_line = lines[impl_close_idx]
    close_end = sum(len(l)+1 for l in lines[:impl_close_idx+1])
    print('Close line:', repr(close_line))
    print('Close end:', close_end)
    
    new_impl_content = chr(10).join(chunks) + chr(10) + chr(10)
    
    new_content = content[:close_end] + chr(10) + new_impl_content + chr(10) + chr(10) + content[close_end:]
    
    with open('d:/game/mytemple/src-tauri/src/app.rs', 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    print('Wrote new app.rs:', len(new_content), 'chars')
else:
    print('ERROR: Could not find impl close')
