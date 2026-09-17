# final.py - reads chunk files and modifies app.rs
import base64, os

BL = chr(123)
BR = chr(125)
DQ = chr(34)

# Read chunks from b64 files
def load_chunks():
    chunks = []
    i = 1
    while True:
        path = f'd:/game/mytemple/chunk_{i:02d}.b64'
        if not os.path.exists(path):
            break
        with open(path) as f:
            encoded = f.read().strip()
        decoded = base64.b64decode(encoded).decode('utf-8')
        chunks.append(decoded)
        print(f'  Loaded chunk {i:02d}: {len(decoded)} chars')
        i += 1
    return chunks

print('Loading chunks...')
chunks = load_chunks()
print(f'Total chunks: {len(chunks)}')
