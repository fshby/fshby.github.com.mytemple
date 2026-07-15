# 文档知识库说明

这是一个本地 Markdown 技术文档查看页面。把 `.md` 文件放进 `docs/` 目录后，左侧目录会按照文件夹结构分类显示。

## 日常查阅

      ![screenshot-1784002006408](/source/screenshot-1784002006408.webp)


- 在左侧选择文件即可切换阅读。
- 使用顶部搜索框检索全部 Markdown 内容。
- 点击“修改”可以编辑当前文档，并在右侧实时预览。
- 点击“图谱”可以查看文档之间的链接、标签和关键词关联。

## 文档关联

你可以使用 `[[架构设计]]` 这样的双链语法，也可以使用普通 Markdown 链接，例如 [架构设计](architecture/system-design.md)。

给文档增加标签也会让图谱更准确：

后续重新打包命令

```md
---
tags: markdown search graph
---
```

#markdown #knowledge#github
