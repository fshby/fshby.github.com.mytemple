# -*- coding: utf-8 -*-
with open('d:/game/mytemple/src-tauri/src/app.rs', encoding='utf-8') as f:
    content = f.read()

idx = content.find('trim_matches')
print('Found at:', idx)
if idx >= 0:
    print(repr(content[idx:idx+150]))
