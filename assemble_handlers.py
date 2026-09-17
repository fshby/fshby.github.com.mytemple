# -*- coding: utf-8 -*-
import base64, os

DQ = chr(34)

# Build routes string
route_lines = [
    '        // File operations (Phase 2)',
    '        .route(' + DQ + '/api/files/move' + DQ + ', post(move_file))',
    '        .route(' + DQ + '/api/files/copy' + DQ + ', post(copy_file))',
    '        .route(' + DQ + '/api/files/rename' + DQ + ', post(rename_file))',
    '        // Frontmatter',
    '        .route(' + DQ + '/api/files/*path/frontmatter' + DQ + ', get(get_frontmatter_handler))',
    '        .route(' + DQ + '/api/files/*path/frontmatter/preview' + DQ + ', get(preview_frontmatter_handler))',
    '        .route(' + DQ + '/api/files/*path/frontmatter' + DQ + ', post(apply_frontmatter_handler))',
    '        // Detailed health',
    '        .route(' + DQ + '/api/health/detailed' + DQ + ', get(health_detailed))',
    '        // System operations',
    '        .route(' + DQ + '/api/system/open-folder' + DQ + ', post(open_folder))',
    '        .route(' + DQ + '/api/system/open-url' + DQ + ', post(open_url))',
    '        .route(' + DQ + '/api/system/browse-folder' + DQ + ', get(browse_folder))',
]
NEW_ROUTES = chr(10).join(route_lines) + chr(10)

# Load handler chunks
handler_chunks = []
for i in range(1, 7):
    path = 'd:/game/mytemple/h_chunk' + str(i) + '.b64'
    if os.path.exists(path):
        with open(path) as f:
            decoded = base64.b64decode(f.read().strip()).decode('utf-8')
        handler_chunks.append(decoded)
        print('Loaded h_chunk' + str(i) + ':', len(decoded), 'chars')

HANDLERS_CODE = chr(10).join(handler_chunks) + chr(10)
print('Total handlers:', len(HANDLERS_CODE), 'chars')

# Read current handlers.rs
with open('d:/game/mytemple/src-tauri/src/handlers.rs', encoding='utf-8') as f:
    content = f.read()

# Insert new routes before .with_state(state)
marker = '.with_state(state)'
idx = content.find(marker)
if idx >= 0:
    line_start = content.rfind(chr(10), 0, idx) + 1
    content = content[:line_start] + NEW_ROUTES + content[line_start:]
    print('Inserted routes at:', line_start)
else:
    print('ERROR: with_state not found')

# Append handlers at end
if not content.endswith(chr(10)):
    content += chr(10)
content += chr(10) + HANDLERS_CODE

with open('d:/game/mytemple/src-tauri/src/handlers.rs', 'w', encoding='utf-8') as f:
    f.write(content)

print('Wrote new handlers.rs:', len(content), 'chars')
