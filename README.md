# Spectra Archive

归档端服务：接收质谱采集端（崩溃后）重送的整批原始谱图，校验哈希链完整性后
原子提交；任何截断或篡改都不会留下可被误作完整实验的半批数据。

## 运行

```bash
docker compose up --build api                 # 默认宿主机端口 8080
HOST_PORT=9000 docker compose up --build api  # 可配置宿主机端口
```

一次性验证服务（等待 API 健康 → 编译检查 → 单元/集成测试 → 明文与 gzip 冒烟，
按退出码结束）：

```bash
docker compose up --build --exit-code-from verify
echo $?   # 0 = 全部通过
```

数据保存在命名卷 `run-data`（容器内 `/data/runs.db`，SQLite/WAL），容器重启、
重新部署后已提交批次保持一致，重复 runId 依旧被拒绝。

## 接口

### `POST /api/runs/{runId}`

- 请求体：NDJSON（`Content-Encoding: gzip` 可选；带 gzip 魔数但未声明编码的
  请求体也会按 gzip 处理）。整批 **1–500 行**，解压后 **≤ 2 MiB**。
- 每行字段：
  - `sequence`：从 0 开始的连续整数；
  - `payload`：Base64 编码的谱图字节；
  - `prevHash`：首行为 64 个 `0`，其余为上一行的 `hash`；
  - `hash`：`SHA-256(prevHash 原始 32 字节 || payload 解码字节)` 的小写十六进制。
- 请求头 `X-Final-Hash` 必须等于末行 `hash`（整批承诺，用于识别截断）。
- 全部行合法且承诺匹配 → `201`，响应体含 `runId / lineCount / finalHash`，
  并带 `Location: /api/runs/{runId}`。
- 任何失败 → 结构化错误，**不会留下任何可查询数据**；同一 `runId` 并发提交
  只有一批能成功（SQLite `BEGIN IMMEDIATE` + 主键约束），其余得到 `409`。

### `GET /api/runs/{runId}`

按 `sequence` 顺序返回已提交行及 `finalHash / lineCount / committedAt`。
不存在 → `404 run_not_found`。

### `GET /health`

存活/就绪探针（Dockerfile `HEALTHCHECK` 与 Compose `healthcheck` 均使用）。

## 错误格式（稳定结构）

```json
{"error": {"code": "hash_mismatch", "message": "...", "details": {"line": 1, "...": "..."}}}
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `empty_batch` / `empty_line` / `invalid_json` / `invalid_line` | 批次或行格式错误 |
| 400 | `missing_field` / `invalid_field` / `invalid_base64` | 字段缺失、类型或格式错误 |
| 400 | `sequence_mismatch` | sequence 不连续/不从 0 开始 |
| 400 | `prev_hash_mismatch` / `hash_mismatch` | 哈希链断裂或被篡改 |
| 400 | `final_hash_missing` / `invalid_final_hash` / `final_hash_mismatch` | 末行承诺缺失/非法/不匹配（截断） |
| 400 | `too_many_lines` / `invalid_gzip` / `invalid_run_id` | 超限、gzip 损坏、runId 非法 |
| 404 | `run_not_found` / `not_found` | 批次不存在 / 路由不存在 |
| 409 | `run_already_exists` | runId 已提交（重复或并发） |
| 413 | `payload_too_large` | 解压后超 2 MiB（含 gzip 炸弹防护） |
| 415 | `unsupported_content_encoding` | 不支持的 Content-Encoding |

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HOST_PORT` | `8080` | Compose 宿主机映射端口 |
| `PORT` | `8000` | 容器内监听端口 |
| `DATA_DIR` | `/data`（本地 `./data`） | SQLite 数据目录 |
| `DATABASE_PATH` | `$DATA_DIR/runs.db` | 数据库文件完整路径（优先） |
| `API_BASE_URL` | `http://api:8000` | verify 服务的目标 API |

## 本地开发

```bash
pip install -r requirements.txt
python -m pytest -q tests          # 单元/集成测试
python -m app.server               # 启动 API（PORT 可配）
API_BASE_URL=http://127.0.0.1:8000 python -m verify   # 完整验证
```

## 设计要点

- **原子提交**：整批在单个 `BEGIN IMMEDIATE` 事务中写入；校验失败或写入失败
  均整体回滚，GET 只能看到完整提交的批次。
- **并发唯一**：`run_id` 主键 + SQLite 写串行化，同一 runId 并发仅一批成功。
- **截断识别**：`X-Final-Hash` 承诺末行哈希；崩溃后重送的前缀批次必然
  承诺不匹配而被拒，不留半批数据。
- **篡改识别**：逐行重算 `SHA-256(prevHash 字节 || payload 字节)` 并校验链式
  `prevHash`，任何一行被改动都会失败。
- **资源防护**：解压流式限长（2 MiB），压缩体上限 2 MiB + 64 KiB，
  声明的 Content-Length 超限直接 413。
