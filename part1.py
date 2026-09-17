APP_RS = 'd:/game/mytemple/src-tauri/src/app.rs'
with open(APP_RS, 'rb') as f:
    data = f.read()
NL = b'\r\n'
DQ = bytes([34])
old_block = b'encoding: ' + DQ + b'utf-8' + DQ + b'.to_string(),' + NL + NL + b'        }' + NL + NL + b'    }' + NL + NL + b'}' + NL + NL + NL + NL + b'// ========== '
print('Found:', old_block in data)
print('Size:', len(data))
