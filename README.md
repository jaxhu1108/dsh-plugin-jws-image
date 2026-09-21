# dsh-plugin-jws-image

DSH 的 JWS 生图插件：agent 工具 `jws_generate_image` + 输入框下方的生图入口。

- 接口：`https://image.aijws.com/v1`（**原生面**：目录 → 报价 → 上传 → 任务 → 下载）
- 密钥：`JWS_API_KEY` 环境变量，或 `~/.config/jws-image/config.json`（**与 `jws-api-demo` skill 共用同一份**）
- 密钥**只在宿主进程**；浏览器不接触、不存储、不记录

## 开发

```powershell
node --test                        # 跑测试（不要写 `node --test test/`，本机 Node 会把目录参数当模块路径）
npm pack                           # 打包
dsh plugin --profile web add .\dsh-plugin-jws-image-0.1.1.tgz
# 首次安装必须重启网关（bundle 列表在启动时读取）
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\.dsh\restart-web-gateway.ps1"
```

装好后：

| 改动 | 生效方式 |
|---|---|
| `lib/client.js` | **存盘即热重载**（`dsh-client-hmr` 在轮询），无需重启 |
| `lib/index.js` 等宿主代码 | 需要重启网关 |
| `cordis.patch.yml` | 热重载 |

## 版本基线

首次安装时记录，供 DSH 升级后回归比对：

- `dsh --version`：`0.1.5-rc.1`（web 栈 `0.1.5-rc.2`）
- 能力探针：见 `logs\web-gateway.stdout.log` 里的 `jws-image probe: services=...` 一行
- 客户端 bundle：`/plugins/dsh-plugin-jws-image/client.js`

## 降级设计

DSH 还是 RC，slot 名与服务都可能变。本插件按设计**安静降级**而不是崩：

- 入口 slot 按 `conversation.composer.dock` → `conversation.input.right` → `conversation.input.left`
  顺序探测；一个都不可用就只保留工具，不影响 agent 生图
- 客户端 `apply` 整体 try/catch —— 抛错会污染整个启动画面
- 每个 `ctx.get(...)` 都判 `undefined`：拿不到 `attachments` 就只回文件路径
- 契约快照 + 指纹比对：API 有变更会在工具结果里提示，**但绝不自动改写请求参数**

## 自测

```powershell
node --test                                          # 全部单元测试
node --test test/jws-api.test.mjs                    # 单个文件
```

## 已知限制

- 第一版只做**图片**（架构已为视频留口子，`/v1/videos*` 未接）
- 图片送进对话受**当前路由模型是否支持图片输入**门禁（Phase 4 处理）
- 生成窗口、密钥设置界面、路由属后续计划（Phase 2+）