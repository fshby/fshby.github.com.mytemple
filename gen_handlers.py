# -*- coding: utf-8 -*-
import base64

BL = chr(123)
BR = chr(125)
DQ = chr(34)
BN = chr(92)

# Build new routes and handler content
# We need to add routes and handlers

# New routes to add to build_native_router
new_routes = '''
        // 文件操作 (Phase 2)
        .route(" /api/files/move\, post(move_file))
 .route(\/api/files/copy\, post(copy_file))
 .route(\/api/files/rename\, post(rename_file))
 // Frontmatter
 .route(\/api/files/*path/frontmatter\, get(get_frontmatter_handler))
 .route(\/api/files/*path/frontmatter/preview\, get(preview_frontmatter_handler))
 .route(\/api/files/*path/frontmatter\, post(apply_frontmatter_handler))
 // 健康检查 (detailed)
 .route(\/api/health/detailed\, get(health_detailed))
 // 系统操作
 .route(\/api/system/open-folder\, post(open_folder))
 .route(\/api/system/open-url\, post(open_url))
 .route(\/api/system/browse-folder\, get(browse_folder))
'''

print('New routes prepared')
