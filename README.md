# Modern Wiz MCP

为知笔记 MCP。搜索、读取、新建、修改和删除新版协同文章，传统文章只支持读取。

## Docker

```sh
docker run -d --name wiz-mcp \
  -p 127.0.0.1:8790:8790 \
  -e WIZ_USER_ID=账号 \
  -e WIZ_PASSWORD=密码 \
  -e MCP_AUTH_TOKEN=密钥 \
  -v wiz-mcp-data:/app/.data \
  jiahuifu/modern-wiz-mcp:0.1.0
```

## Docker Compose

```sh
cp .env.example .env
docker compose up -d
```

地址 `http://127.0.0.1:8790/mcp`，请求头 `Authorization: Bearer <MCP_AUTH_TOKEN>`。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `list_folders` | 列出文件夹 |
| `list_articles` | 按文件夹列出标题和摘要 |
| `search_articles` | 按关键词搜索，再筛到指定文件夹 |
| `get_article` | 读取正文。新版协同文章返回 Markdown 和版本；传统 HTML 笔记转成 Markdown，只能读 |
| `create_article` | 新建一篇协同笔记 |
| `update_article` | 修改正文，服务器确认后返回 `saved: true` |
| `delete_article` | 把笔记移入回收站 |
| `upload_image` | 在文章末尾再插入一张图片 |
| `get_write_status` | 保存结果不确定时，按 `requestId` 查询 |

也可以用资源 `wiz://articles/{docId}` 读取正文。

没写 `folder` 时，列出、搜索和新建都放在 `/AI/`。搜不到只说明它不在这个文件夹。传统 HTML 笔记可以读取，不能修改。正文里的 https 图片会由服务下载并上传到为知。

## 许可

[MIT](LICENSE)
