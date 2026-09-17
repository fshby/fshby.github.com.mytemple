import sys
APP_RS = 'd:/game/mytemple/src-tauri/src/app.rs'
with open(APP_RS, 'rb') as f:
    c = f.read()
NL = b'\r\n'
Q = bytes([34])
pattern = b'encoding: ' + Q + b'utf-8' + Q + b'.to_string(),' + NL + NL + b'        }' + NL + NL + b'    }' + NL + NL + b'}' + NL + NL + NL + NL + b'// ========== '
print('Found pattern:', pattern in c)
print('Index:', c.find(pattern))
print('Total len:', len(c))
