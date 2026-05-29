# LinLab 湖仓作业平台原型：完整验收步骤说明

## 0. 验收目标与范围
- 目标：验证单用户通过 IAM 在湖仓平台完成脚本开发与执行、数据资产管理、数据集归档存储的全链路闭环。
- 范围组件：Keycloak（IAM）、Notebook（Jupyter）、Spark、Ray、Iceberg REST Catalog、Iceberg、lakeFS、MinIO、platform-api、job-runner、console。

## 1. 环境启动与服务就绪
### 操作步骤
1. 进入工程根目录并启动服务：
   - `docker compose up -d --build`
2. 查看容器状态：
   - `docker compose ps`
3. 调用健康检查接口：
   - `GET http://localhost:8090/healthz`
   - `GET http://localhost:8070/healthz`

### 关键 IT 处理
- Docker Compose 拉起多容器编排网络，建立服务间 DNS（如 `platform-api -> job-runner`）。
- `platform-api` 启动时初始化 SQLite 元数据并启动调度器（orchestrator）。
- `job-runner` 启动 Uvicorn 服务，暴露执行入口 `/run`。

### 目的
- 确认底座可用，避免后续验收因基础服务不可达产生误判。

---

## 2. IAM 单用户鉴权验收
### 操作步骤
1. 向 Keycloak 申请 token（password grant，演示用户 `linuser`）。
2. 携带 Bearer Token 调用：
   - `GET http://localhost:8090/whoami`

### 关键 IT 处理
- Keycloak 校验用户凭据，签发 JWT Access Token。
- `platform-api` 通过 JWKS 拉取公钥并校验 token 的签名、issuer、aud/azp。
- 鉴权通过后返回用户身份声明（`preferred_username` 等）。

### 目的
- 验证“平台所有关键操作受 IAM 保护”，确认单用户身份链路完整。

---

## 3. 作业平台接口验收（控制面）
### 操作步骤
1. 查询作业定义：
   - `GET /jobs`
2. 手工触发作业：
   - `POST /jobs/1/runs`，`{"trigger_type":"manual"}`
3. 轮询运行状态：
   - `GET /job-runs?limit=10`

### 关键 IT 处理
- `GET /jobs`：从 SQLite 的 `jobs` 表读取作业配置（cron、namespace、table、archive 模板）。
- `POST /jobs/{id}/runs`：
  - 插入 `job_runs` 记录（初始 `running`）。
  - orchestrator 异步提交执行任务到线程池。
- `GET /job-runs`：读取运行历史，返回状态、时间、日志、错误信息。

### 目的
- 验证平台具备 Databricks 风格的作业定义、触发、跟踪能力。

---

## 4. 作业执行主链路验收（数据面）
### 操作步骤
1. 触发后观察 job run 从 `running` 到 `success`。
2. 查看 `log_text` 是否含计算、资产、归档结果。

### 关键 IT 处理
- Orchestrator 调用 `job-runner /run`，传入 `namespace/table/archive_branch/archive_tag`。
- Job-runner 内部处理：
  1. 通过 IAM 获取机器执行 token。
  2. 调用 `platform-api /assets/init` 初始化 Catalog 命名空间。
  3. 启动 SparkSession（Iceberg REST Catalog 模式），执行：
     - `CREATE NAMESPACE`、`CREATE TABLE`、`INSERT`、`SELECT`。
  4. 连接 Ray 集群执行质量统计任务（row_count、purchase_count 等）。
  5. 调用 archive 接口完成 lakeFS 分支、提交、打标。
  6. 调用 `/assets/list` 回读资产视图。
- 执行完成后 orchestrator 回写 `job_runs` 为 `success/failed`，并写入日志。

### 目的
- 验证“作业编排 -> Spark/Ray 计算 -> 资产与归档”全链路自动执行能力。

---

## 5. 数据资产管理验收（Catalog + Iceberg）
### 操作步骤
1. 查询资产列表：
   - `GET /assets/list`
2. 核对返回的 namespace/table（如 `bronze.events`）。

### 关键 IT 处理
- `assets/init` 调用 Iceberg REST Catalog `POST /v1/namespaces` 建立命名空间。
- Spark 对 Iceberg 表执行 DDL/DML，Catalog 记录元数据演进。
- `assets/list` 通过 Catalog API 遍历 namespace 与 table identifiers。

### 目的
- 验证平台对“数据集资产”的可创建、可发现、可查询能力。

---

## 6. 数据归档验收（lakeFS + MinIO）
### 操作步骤
1. 在运行日志中检查 archive 字段：
   - `branch.status = ready`
   - `tag.status = archived`
   - `commit` 成功或 `no_changes`
2. 可选：登录 lakeFS UI 复核分支与标签。

### 关键 IT 处理
- `archive/branch`：基于主分支创建归档分支（按日期模板）。
- `archive/commit`：提交归档快照；无增量时返回 `no_changes`（容错逻辑）。
- `archive/tag`：按 commit_id 打归档标签，形成可追溯快照点。
- lakeFS 元数据与对象数据最终落在 MinIO 后端存储。

### 目的
- 验证数据集具备版本化管理与归档留存能力，支持审计与回溯。

---

## 7. Notebook 脚本开发与执行验收
### 操作步骤
1. 在 notebook 容器执行演示脚本：
   - `python /home/jovyan/work/lakehouse_demo.py`
2. 核查输出是否覆盖 IAM、Spark、Ray、assets、archive。

### 关键 IT 处理
- Notebook 作为脚本开发入口，复用与 job-runner 相同的湖仓接口与计算能力。
- 通过同一 IAM + Catalog + Iceberg + lakeFS 通道执行，确保开发态与调度态一致。

### 目的
- 验证“开发执行一体化”：研发脚本可平滑迁移到平台作业运行。

---

## 8. Console UI 验收（交互面）
### 操作步骤
1. 打开 `http://localhost:3000` 并登录。
2. 查看 jobs 列表。
3. 触发 run。
4. 查看 run 历史和日志摘要。

### 关键 IT 处理
- Console 调用 Keycloak 进行用户登录并获取 token。
- Console 持 token 调用 platform-api 的 jobs/runs 接口。
- 前端实时展示运行状态流转与关键日志。

### 目的
- 验证面向业务/运维的可视化操作闭环，而非仅 API 脚本可用。

---

## 9. 验收通过判定标准
1. IAM：单用户能成功鉴权并访问受保护 API。
2. 作业平台：可查询作业、触发运行、查看运行历史。
3. 计算链路：Spark 与 Ray 均实际执行并产出结果。
4. 资产管理：Catalog 中可见 namespace 与表资产。
5. 归档存储：lakeFS 分支与标签创建成功，no-op commit 可容错。
6. 交互能力：Console 可完成登录、触发、回查。

---

## 10. 常见异常与定位建议
1. 鉴权失败（401）：
   - 检查 Keycloak realm/client/user 配置，核对 issuer/audience。
2. 作业长时间 running：
   - 查看 `platform-api` 与 `job-runner` 日志，重点排查 runner 回调与 Spark 依赖下载。
3. 资产列表为空：
   - 检查 Catalog 可达性、Iceberg warehouse 路径、S3 endpoint/密钥。
4. 归档失败：
   - 检查 lakeFS access key/secret、仓库/分支名称、commit/tag 接口返回。

---

## 11. 验收结论模板（填写）
- 验收日期：`____-__-__`
- 环境：`________________`
- 结果：`通过 / 限制通过 / 不通过`
- 关键证据：
  1. `________________________________`
  2. `________________________________`
  3. `________________________________`
- 遗留项：
  1. `________________________________`
  2. `________________________________`
