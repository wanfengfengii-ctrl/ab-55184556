# Mass-Spec Run Archive

归档端：接收采集进程 POST 的 NDJSON（可选 gzip）整批谱图，逐行验证
哈希链与批次终结摘要，只有整批合法才原子提交；截断、篡改、重复 runId
都不会留下任何可被误作完整实验的数据。

零依赖，仅使用 Node.js 内置模块（`http` / `crypto` / `zlib` / `fs`），
Node >= 20。

## 协议

`POST /api/runs/{runId}`

- Body：NDJSON，每行一个 JSON 对象：
  ```json
  {"sequence":0,"payload":"<Base64>","prevHash":"000…0","hash":"<sha256 hex>"}
  ```
- 可选 `Content-Encoding: gzip`（解压后同样受 2 MiB 限制，gzip 炸弹会被流式截断）
- 必须携带 `X-Final-Hash: <64 个小写十六进制字符>`
- 约束：1–500 行；解压后 ≤ 2 MiB（2 \* 1024 \* 1024 字节）
- `sequence` 必须从 0 开始逐行连续
- 首行 `prevHash` 必须是 64 个零；之后每行 `prevHash` 等于上一行 `hash`
- 哈希定义：
  `hash_i = SHA256( hexDecode(prevHash_i) || base64Decode(payload_i) )`，小写十六进制
- 仅当所有行合法 **且** 末行 `hash == X-Final-Hash` 时返回 `201 Created`
  并带 `Location: /api/runs/{runId}`

`GET /api/runs/{runId}`：按 sequence 顺序返回已提交批次
（`status: "committed"`、`count`、`finalHash`、`rows`）。容器重启后结果一致。

`GET /healthz`：健康检查，返回 `{"status":"ok"}`。

### 结构化错误

所有失败返回：

```json
{ "error": { "code": "HASH_MISMATCH", "message": "...", "runId": "...", "details": {"line": 2} } }
```

| 场景 | HTTP | error.code |
| --- | --- | --- |
| runId 不存在（GET） | 404 | `RUN_NOT_FOUND` |
| runId 已提交 / 并发重复 | 409 | `RUN_ALREADY_EXISTS` |
| 截断（末行 hash 与 X-Final-Hash 不符） | 422 | `FINAL_HASH_MISMATCH` |
| 链条链接断裂 | 422 | `PREV_HASH_MISMATCH` |
| payload 篡改导致摘要错误 | 422 | `HASH_MISMATCH` |
| 超过 500 行 / 2 MiB | 413 | `BATCH_TOO_MANY_LINES` / `BATCH_TOO_LARGE` |
| gzip 流损坏 | 400 | `INVALID_GZIP` |
| 缺 X-Final-Hash 或格式错 | 400 | `FINAL_HASH_INVALID` |

任何失败的 POST 都不写盘；崩溃残留的 `*.tmp` 文件在启动时清理且永不提供。

## 本地运行

```bash
npm test                       # 31 个单元/集成测试
DATA_DIR=./data PORT=8080 npm start
```

## Docker

```bash
docker compose up -d --build api                 # 默认宿主机端口 8080
HOST_PORT=9090 docker compose up -d --build api  # 自定义宿主机端口
curl http://localhost:8080/healthz
```

- 端口通过 `HOST_PORT` 环境变量配置（见 `.env.example`）。
- 数据保存在命名卷 `run-data`（容器内 `/data`），容器重建/重启后一致。
- 镜像与 Compose 均配置了 `GET /healthz` 健康检查。

### 一次性 verify 服务

```bash
docker compose up --build verify
```

`verify` 会：等待 API 健康（`depends_on: service_healthy` + 主动轮询）→
语法构建检查 → 全部代码测试 → 明文 NDJSON 冒烟 → gzip NDJSON 冒烟，
随后按自身退出码结束（`restart: "no"`；全部成功退出 0）。

## 提交语义（崩溃安全）

1. 整个 body 在内存中解压、解析、逐行验链、比对 `X-Final-Hash`；
2. 写入唯名临时文件并 `fsync`；
3. `link(tmp, 最终文件)` 原子占位——并发/多进程下只有一个成功，其余得到稳定 `409`；
4. fsync 目录后删除临时名。

启动时扫描数据目录：只有能重新通过完整哈希链验证的记录才会被加载，
其余记录（磁盘篡改/半批文件）一律不提供查询。
