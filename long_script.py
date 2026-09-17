import base64, sys
print(base64.b64decode(sys.argv[1]).decode())
