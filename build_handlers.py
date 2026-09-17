# -*- coding: utf-8 -*-
BL = chr(123)
BR = chr(125)
DQ = chr(34)
BN = chr(92)

# Helper to produce route lines with proper indentation
def route_line(method, path, handler):
    return '        .route(' + DQ + path + DQ + ', ' + method + '(' + handler + '))'

lines = []
# File operation routes
lines.append('        // File operations (Phase 2)')
lines.append(route_line('post', '/api/files/move', 'move_file'))
lines.append(route_line('post', '/api/files/copy', 'copy_file'))
lines.append(route_line('post', '/api/files/rename', 'rename_file'))
lines.append('        // Frontmatter')
lines.append(route_line('get', '/api/files/*path/frontmatter', 'get_frontmatter_handler'))
lines.append(route_line('get', '/api/files/*path/frontmatter/preview', 'preview_frontmatter_handler'))
lines.append(route_line('post', '/api/files/*path/frontmatter', 'apply_frontmatter_handler'))
lines.append('        // Detailed health')
lines.append(route_line('get', '/api/health/detailed', 'health_detailed'))
lines.append('        // System operations')
lines.append(route_line('post', '/api/system/open-folder', 'open_folder'))
lines.append(route_line('post', '/api/system/open-url', 'open_url'))
lines.append(route_line('get', '/api/system/browse-folder', 'browse_folder'))

NEW_ROUTES = chr(10).join(lines) + chr(10)
print('Routes block:')
print(NEW_ROUTES)
