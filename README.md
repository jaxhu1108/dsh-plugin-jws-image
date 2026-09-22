# dsh-plugin-jws-image

DSH 的 JWS 生图插件：agent 工具 `jws_generate_image` + **右侧栏里的生图界面**。

- 接口：`https://image.aijws.com/v1`（**原生面**：目录 → 报价 → 上传 → 任务 → 下载）
- 密钥：`JWS_API_KEY` 环境变量，或 `~/.config/jws-image/config.json`（**与 `jws-api-demo` skill 共用同一份**）
- 密钥**只在宿主进程**；浏览器不接触、不存储、不记录

## 界面放在哪：右侧栏 tab

生图界面**开在右侧栏**（和文件树、预览、指南同一列），不是弹窗。

注册是**两段式**，少一段就会开出一个空 tab：

1. `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` —— 这个 tab **是什么**。
   `id` 必须自己带：**`kind` 不唯一**（extension 可以顶掉 builtin 的同 kind）。
2. 正文与标题分别注册进 **带 key 的** `sidebar.right.pane.tab` /
   `sidebar.right.pane.tab.title`，key 用那个 **`id`**，不是 `kind`
   —— 这是最容易错的一步，测试专门钉住它。
3. `ctx.sidebarRight.openTab(kind)` 打开。

`priority: 'extension'`（产品外的类型，优先级高于自带 viewer），并在指南页放了一个入口。

这三个服务**走 `ctx.inject([...])` 等**，不放进插件自己的 `inject` 列表：
放进去的话，没有右侧栏的部署会连 dock 入口和浏览器半边都不加载。
dock 入口**先试右侧栏，失败才回落弹窗**，两种构建都能用。

> 两个由"不再走弹窗"引出的坑，都已修：
> 入口原来靠弹窗那次 state 请求才知道有没有密钥，改成挂载时就查，
> 否则「未配置密钥 · 点此设置」再也不会出现；
> 样式表原来在点击时才注入，而 tab 可能由侧栏自己打开（指南页、恢复的布局），
> 现在面板挂载时自己注入。

## 两条入口，同一套宿主代码

| 入口 | 走什么 |
|---|---|
| agent 工具 `jws_generate_image` | 宿主直接调 API |
| 输入框下方 dock 入口 → **右侧栏生图 tab** | 浏览器调 `/api/jws-image/*`，宿主代调 API |

界面**首次打开**若没有密钥，直接显示密钥设置页（粘贴 → 宿主先校验再写盘 0600），
不需要用户去终端跑 skill 的 `setup`。已配密钥时显示生图表单。

表单里的**模型 / 尺寸 / 分辨率 / 质量全部来自实时 `catalog`**，没有一个写死的枚举；
换模型会把尺寸等字段整体重置成新模型自己的那条 SKU，因为接口要求
`mode/size/resolution/quality` 必须同出一条 `skus[]` 记录。

宿主路由（都挂在 `/api/jws-image/` 下，`/api` 是共享命名空间所以统一前缀）：

| 路由 | 作用 |
|---|---|
| `GET  /state` | 是否已配密钥、默认模型、预算、进行中任务 |
| `POST /key` | 先校验再写盘；**响应只回 ok，不回显密钥** |
| `GET  /catalog` | 代理模型目录（剥掉计价内部字段） |
| `POST /quote` | 代理报价 |
| `POST /generate` | 生成并把图片以 base64 回给窗口预览 |
| `GET  /task?id=` | 轮询任务 |
| `GET  /history` | 本次进程的出图历史 |
| `GET  /api-status` | 契约新鲜度 |
| `POST /api-update` | 重新钉快照并报告差异（**不改请求构造逻辑**） |

## 模型与参数从哪来

不写死任何模型 id 或尺寸。每次调用按这个顺序定模型：

1. 调用参数 `model`
2. 配置的 `defaultModel`
3. 实时目录里第一个支持 `text-to-image` 的模型

`size / resolution / quality` 取自该模型 `skus[]` 里 `mode` **匹配本次调用**的那条记录
（接口要求这几个字段必须同出一条 SKU，否则会被拒）。目录读不到时退回最后一手默认值，
让接口做裁判；但如果连模型都没指定，目录读不到就是明确报错。

## 预算与币种

预算是用户按 **元** 写的（默认 20），而接口报价币种是 **USD**。两者**不做汇率换算**
——离线凭空造一个汇率会悄悄改变熔断线。金额按原样比较，币种不一致时在结果里
明说，并提示把 `maxAmount` 换成报价币种的数值。

## 开发

```powershell
node --test                        # 跑测试（不要写 `node --test test/`，本机 Node 会把目录参数当模块路径）
npm pack                           # 打包
dsh plugin --profile web add .\dsh-plugin-jws-image-0.1.5.tgz
# 首次安装必须重启网关（bundle 列表在启动时读取）
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\.dsh\restart-web-gateway.ps1"
```

打包有个坑：**同版本号重新打包 pnpm 会用缓存**，profile 里仍装旧文件。改完必须
bump `version` 再 pack，否则"装上了但没生效"。

`package.json` 的 `files` 用 **`"lib"` 整个目录**，不逐个列文件：
0.1.0–0.1.2 曾经逐个列，结果后加的 `lib/generate.js` 没进包，
而 `lib/index.js` 却 import 它 —— 开发机因为手工拷过文件所以看不出，
干净安装会在启动时崩。`test/package.test.mjs` 现在会对着真实 packlist
断言"每个相对 import 都被发布"，改动 `files` 后跑一遍就知道。

装好后：

| 改动 | 生效方式 |
|---|---|
| `lib/client.js` | **存盘即热重载**（`dsh-client-hmr` 在轮询），无需重启 |
| `lib/index.js`、`lib/routes.js` 等宿主代码 | 需要重启网关 |
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
- **注册必须走 `slots.inject(name, () => slots.register(...))`**：slot 是**声明**，
  `register()` 在声明之前调用会抛 `slot "..." is not declared`。直接 register
  再套个 catch 吞掉，表现就是"插件装好了、bundle 也 200、但界面什么都没有"
- 窗口优先用 `dsh-client-ui-primitives` 的 `Modal`，拿不到就回落到自带的
  `createPortal` 遮罩 + 裸元素；原语改名只会让窗口变朴素，功能不受影响
- 客户端 `apply` 整体 try/catch —— 抛错会污染整个启动画面
- 每个 `ctx.get(...)` 都判 `undefined`：拿不到 `connection` 就只注册工具，不注册路由
- 契约快照 + 指纹比对：API 有变更会在工具结果里提示，**但绝不自动改写请求参数**

## 自测

```powershell
node --test                                          # 全部单元测试
node --test test/routes.test.mjs                     # 单个文件
```

浏览器半边没有构建链，所以测试用一个小 hook harness 直接渲染组件：
`test/client-window.test.mjs` 会真的点"报价"、真的发请求，断言发出去的参数。

## 已知限制

- 第一版只做**图片**（架构已为视频留口子，`/v1/videos*` 未接）
- 参考图上传（Phase 3）与"送进当前对话"（Phase 4）未接：窗口目前是文生图
- 历史存在宿主进程内存里，重启网关即清空
- 密钥的 `JWS_IMAGE_CONFIG_DIR` 环境变量可覆盖配置目录（与 skill 脚本的 `configDir` 选项对应），
  主要用于测试时避开操作者真实密钥