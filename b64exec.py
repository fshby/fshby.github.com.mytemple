import base64, sys
data = sys.stdin.read()
exec(base64.b64decode(data).decode())
