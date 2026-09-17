import sys
lines = []
lines.append('import base64, sys')
lines.append('data = sys.stdin.read()')
lines.append('exec(base64.b64decode(data).decode())')
with open(r'd:\game\mytemple\b64exec.py', 'w') as f:
    f.write(chr(10).join(lines) + chr(10))
print('wrote b64exec.py')
