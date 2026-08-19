# 法律知识包发布与使用

法律知识包是「Lily · 中国企业法律顾问」的独立依赖，不是角色设定、人物设定或世界书。世界书保持停用。

## 发布

客户原始 ZIP 只在受控发布环境读取，不能直接上传给客户端，也不能执行其中的 `tools/`、JavaScript、HTML、模型或其他可执行文件。转换器只提取法规 Markdown 条款、来源信息和版本沿革：

```bash
node scripts/build-legal-kb-pack.mjs \
  --input "/path/to/法律知识库_V23.3.zip" \
  --output "/tmp/legal-cn-enterprise-V23.3" \
  --artifact "dist/legal-cn-enterprise-V23.3.zip"
```

命令输出包含 `sizeBytes` 和 `sha256`。发布前必须确认产物只包含：

- `manifest.json`
- `catalog.json`
- `articles.jsonl`
- `lineage.json`

上传七牛云时使用不可变版本路径，例如：

```bash
node scripts/release-admin.mjs upload \
  --bucket lanrensoft \
  --key app/legal-kb/legal-cn-enterprise/V23.3.zip \
  --file dist/legal-cn-enterprise-V23.3.zip
```

然后由管理员注册版本：

```http
POST /api/admin/legal-knowledge-packs
Content-Type: application/json

{
  "packId": "legal-cn-enterprise",
  "characterId": "lily-cn-legal-counsel",
  "version": "V23.3",
  "url": "https://qny.lanrensoft.cn/app/legal-kb/legal-cn-enterprise/V23.3.zip",
  "sha256": "<sha256>",
  "sizeBytes": 123456789,
  "format": "zip",
  "schemaVersion": 1,
  "minPlan": "free",
  "enabled": true
}
```

知识包地址不会出现在公共目录。客户端请求仍必须通过设备签名，但法律知识包默认不设置套餐门槛，普通用户即可使用。

## 用户体验

用户第一次使用官方法律角色时，应用会自动：

1. 获取当前授权版本；
2. 断点下载并显示“正在准备法律知识库”；
3. 校验文件大小和 SHA-256；
4. 安全解压到本地应用数据目录；
5. 建立本地 SQLite FTS5 索引；
6. 让角色通过 `lily_legal_search` 查询条款。

更新失败时保留上一份可用版本，不会让用户失去已有能力。首次下载无法完成时，法律角色会明确提示依赖未准备好，不会假装已经依据客户知识库作答。

## 回滚

禁用错误版本即可回滚：

```http
PATCH /api/admin/legal-knowledge-packs/<id>
Content-Type: application/json

{"enabled": false}
```

客户端下一次解析会选择仍启用的最高版本。旧版本只有在新版本完整校验和安装成功后才会被替换。
