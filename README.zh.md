# dsh-opencode-go-usage

**DeepSeek Harness（DSH）** 的 OpenCode Go 套餐额度监控插件：在 Web GUI 的 Composer 里、紧贴上下文计程器
（context meter）右侧显示三个阈值配色的圆环，鼠标移上去展开进度条详情面板。

```
… [◔ 45%]  [◕ ◕ ◑]
   上下文     5 小时滚动 / 本周 / 本月
   计程器     OpenCode Go 额度（本插件）
```

| 常驻缩略图（始终可见） | 详情（悬停 / 聚焦 / 点击） |
| --- | --- |
| 三个 14px 圆环，**不带文字**，每个对应一个额度窗口，按自己的已用百分比填充并配色 | 每个窗口一条 6px 进度条 + 一行描述：剩余百分比、重置倒计时、样本新鲜度与手动刷新 |

- **没有模型面**：不注册工具、不加系统提示词、不写会话事件，因此**不消耗任何 prompt token**，也不会使 KV cache 失效。
- **API Key 从不进入浏览器**：宿主半部通过 `ctx.credentials` 解析密钥、自己请求上游，只把额度数字暴露在同源回环路由上。

数据来自官方额度接口 `GET https://opencode.ai/zen/go/v1/usage`（`Authorization: Bearer <key>`）：

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 3,  "resetsAt": "2026-10-02T16:18:57.800Z" },
    "weekly":  { "status": "ok", "percent": 1,  "resetsAt": "2026-10-05T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 59, "resetsAt": "2026-10-11T12:22:02.000Z" } } }
```

`percent` 是**已用**百分比，剩余 = `100 − percent`。

---

## 环境要求

- DSH **0.2.0-rc.2**（本插件的开发与验证基线），需要 Web GUI profile（`@deepseek-ai/dsh-web-app`）
  以及 `conversation.composer.dock` 槽位（由 `@deepseek-ai/dsh-client-ui-conversation` 提供）。
- **OpenCode Go** 订阅及其 API Key，存放在 DSH 能解析到的地方 —— 默认引用名
  `OPENCODE_GO_API_KEY`（与 `llm-pi-ai` 提供方用的是同一个）。可以在 **设置 → 模型** 里填，
  或写进 `~/.dsh/.credentials.yaml`，或设置同名环境变量。
- Windows / macOS / Linux 均可。开发用的检查脚本需要 Node 22+。

圆环 14px、2px 描边，阈值配色 `<60%` 绿 / `≥60%` 黄 / `≥85%` 红；没有数据时是灰环，
上游报错时三个都为红。圆环不带可见文字，信息通过每个环自己的 `title`
（如 `5 小时滚动 · 已用 3%（剩余 97 · ↻3h25m 后重置）`）、整行的 `aria-label` 以及详情面板传达。

---

## 部署方式

下面假设 DSH home 为 `~/.dsh`（Windows 上是 `%USERPROFILE%\.dsh`）。profile 位于
`~/.dsh/profiles/<name>/`；示例用 **desktop** profile（Electron 应用使用的那个）。

安装这个插件永远是同样三件事：

1. **包必须能从 profile 解析到** —— `~/.dsh/profiles/<name>/node_modules/dsh-opencode-go-usage`
   必须存在（指向 checkout 的 junction / symlink，或一份真实拷贝）；
2. **profile 清单里记录它** —— `~/.dsh/profiles/<name>/package.json` 的 `dependencies`；
3. **Loader 需要有一行** —— `~/.dsh/profiles/<name>/cordis.patch.yml` 里的 `insert` 条目。

然后**重启 DSH**。配置热重载只覆盖已装载的行；一个全新包进入 Loader 图是在启动时发生的。

### 方式 A —— 克隆到插件目录（推荐）

```sh
# 1. 把代码放到 profile 能解析到的位置
git clone https://github.com/<you>/dsh-opencode-go-usage.git ~/.dsh/plugins/dsh-opencode-go-usage

# 2. 链接进 profile（Windows 用 junction，POSIX 用软链接）
#    Windows（PowerShell / cmd）：
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-opencode-go-usage" "%USERPROFILE%\.dsh\plugins\dsh-opencode-go-usage"
#    POSIX：
ln -s ~/.dsh/plugins/dsh-opencode-go-usage ~/.dsh/profiles/desktop/node_modules/dsh-opencode-go-usage
```

在 `~/.dsh/profiles/desktop/package.json` 里记录依赖（路径相对 profile 目录，
所以 `../../plugins/...` 就是 `~/.dsh/plugins/...`）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-opencode-go-usage": "file:../../plugins/dsh-opencode-go-usage"
  }
}
```

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加入 Loader 行：

```yaml
- insert:
    - id: opencode-go-usage
      name: "dsh-opencode-go-usage"
      config:
        apiKeyEnv: OPENCODE_GO_API_KEY
        endpoint: https://opencode.ai/zen/go/v1/usage
        refreshMs: 60000
        timeoutMs: 10000
        route: /opencode-go-usage/snapshot
```

> **这两个文件都要写成「无 BOM」的 UTF-8。** Windows PowerShell 的 `Set-Content -Encoding UTF8`
> 会自动加 `EF BB BF`，而 DSH 用 `JSON.parse` 读 `package.json`，于是应用直接起不来并弹窗：
> `Unexpected token '', "{
>   "name"... is not valid JSON`。请用会写无 BOM UTF-8 的编辑器，或
> `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。

### 方式 B —— 用 profile 自带的插件管理器

带 `@deepseek-ai/dsh-plugin-manager`（以及 `dsh` CLI）的部署可以直接装：

```sh
dsh plugin --profile <name> add dsh-opencode-go-usage
```

它内部完成的正是上面同样的三件事（pnpm 装进 profile、记录依赖/bundle、写 patch 行）。

两个注意点：

- **desktop** profile 不能用这条路径 —— `dsh plugin --profile desktop` 被明确拒绝，因为该 profile
  归 Electron 应用独占管理。桌面端请用方式 A。
- 要让安装被记录为 bundle，包本身得声明 bundle。本仓库因此也提供 `cordis.patch.yml` 并在
  `package.json` 里声明 `dsh.bundle.patch`，把它选成 bundle 时会插入同一行。

### 方式 C —— 作为 profile bundle 装载

若你更愿意用 bundle 列表而不是手写行，把本包加入 profile 的 `dsh.profile.bundles`，DSH 会把本仓库
自带的 `cordis.patch.yml` 作为一个 patch 层应用，替你插入那一行：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-opencode-go-usage"] } }
}
```

两种方式插入的是同一个 `id: opencode-go-usage`，所以 profile 层的行会覆盖 bundle 层那行的 config。

### 配置项

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 每次刷新通过 `ctx.credentials` 解析的凭据引用；解析不到时回退到同名环境变量 |
| `apiKey` | — | 直接写密钥（不推荐：会把机密写进 patch 文件） |
| `endpoint` | `https://opencode.ai/zen/go/v1/usage` | 额度接口 |
| `refreshMs` | `60000` | 缓存时长；浏览器按同一周期轮询 |
| `timeoutMs` | `10000` | 单次上游请求超时 |
| `route` | `/opencode-go-usage/snapshot` | 快照路由路径 |

### 验收

```sh
curl http://127.0.0.1:<port>/opencode-go-usage/snapshot/probe
# {"plugin":"dsh-opencode-go-usage","version":"0.1.0",…,"sample":"2026-10-02T16:50:47.860Z","lastError":null}

curl http://127.0.0.1:<port>/opencode-go-usage/snapshot
# {"ok":true,"fetchedAt":"…","windows":{…},"stale":false,"error":null}
```

probe 返回 `404` 说明宿主半部没加载（路径不对、行缺失或 import 失败）。端口在启动时的
`dsh web:` URL 里。之后打开 GUI：额度环出现在 Composer dock 里、上下文计程器右侧。

### 卸载 / 回滚

1. 从 `~/.dsh/profiles/<name>/cordis.patch.yml` 删掉那个 `insert` 块；
2. 从 profile 的 `package.json` 删掉依赖（用过方式 C 的话也删掉 `dsh.profile.bundles` 里的条目）；
3. 删掉 junction `~/.dsh/profiles/<name>/node_modules/dsh-opencode-go-usage`
   （Windows 用 `cmd /c rmdir "<path>"`，**不要**用 `Remove-Item -Recurse`，后者可能顺着链接删掉目标内容）；
4. 可选：删掉 `~/.dsh/plugins/dsh-opencode-go-usage`；
5. 重启 DSH。

只删 checkout 而 patch 行还在，**不会**让 DSH 崩溃：该条目 import 失败，宿主只记一条警告
（`1 entry did not activate` / `failed to import`），GUI 正常启动，只是少了额度环。

---

## 诊断与故障排查

### 快照路由的错误码

| 码 | 含义 |
| --- | --- |
| `unconfigured` | `apiKeyEnv` 指向的凭据不存在，也没有同名环境变量 |
| `unauthorized` | 接口以 401/403 拒绝了密钥 |
| `timeout` | 上游请求超过 `timeoutMs` |
| `connect` | 连不上 `opencode.ai` |
| `http` | 其他非 2xx |
| `parse` | 响应不是 JSON，或没有 `usage` 对象 |
| `no-data` | 响应里没有任何额度窗口 |

浏览器会把这些码本地化；刷新失败时面板保留上一次成功样本并显示「刷新失败，显示上次数据」。

### 症状 → 原因 → 处理

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| DSH 起不来：`Unexpected token '', … is not valid JSON`，弹「The application could not start」 | profile 的 `package.json` 被写成了**带 BOM** 的 UTF-8（通常是 `Set-Content -Encoding UTF8` 干的） | 无 BOM 重写（见方式 A 的警告） |
| 崩溃：`web boot: 1 entry did not activate`，渲染进程控制台报 `duplicate factory registration for "…"` | 浏览器 bundle 注册用的 `id` **不等于包名**，外壳以为该行没注册成功而重取一次，重复注册直接让 web boot 失败 | 让 `window.__ModuleLoader__.load({ id })` 严格等于 `package.json` 的 `name`（所有一方 bundle 都如此；`node tools/check-client.mjs .` 会断言） |
| 行像被忽略、插件始终不加载，除一条 Loader 警告没有别的错 | **裸**的 `- id: <新 id>` 只覆盖组合树里已存在的行；新挂载点必须写成 `insert` 列表 | 用方式 A 里的 `insert` 形式 |
| 行在，但 probe 返回 404 | 包无法从 profile 目录解析（`node_modules` 链接缺失/悬空），或 checkout 被删了 | 重建链接，在 profile 锚点执行 `node -e "require.resolve('dsh-opencode-go-usage')"` 确认，重启 |
| 应用正常但没有额度环也没有 probe 路由 | 同上；或该行被 DSH 的崩溃恢复清掉了（「Disable third-party plugins, back up profile patch, and restart」会重写 `cordis.patch.yml`，并留下 `cordis.patch.yml.bak-<时间戳>`） | 从备份或方式 A 重新加回 `insert` 块，重启 |
| 有环但一直是灰的 | 还没有采样，或接口没返回窗口 | 看 probe 的 `lastError`，再对照上面的错误码 |

---

## 安全说明

- 快照路由由 DSH 自己的回环 Web 服务器（`host: 127.0.0.1`）提供，**只含百分比与重置时间，绝不含 API Key**。
- 该路由没有额外鉴权：任何能访问 GUI 端口的本机进程都能读到这些数字。它们不是机密；若仍介意，
  可把 `route` 改成只有你知道的路径，或整体收紧部署。
- 密钥每次刷新都通过 `ctx.credentials` 解析，所以轮换密钥下一次刷新即生效，无需重启。

## 已知限制

- **常驻显示**：额度环不跟随当前会话模型；宿主有数据就显示。（槽位注入里带了会话的 `provider`，
  想只在 OpenCode Go 模型下显示只需改一行。）
- **单账号**：一个 profile 一个密钥，多账号不在范围内。
- **轮询延迟**：默认 60 秒；面板的 `↻` 立即刷新；标签页隐藏时跳过轮询。
- **词汇固定**：窗口名、阈值与顺序按 OpenCode Go 套餐语义。
- 针对 DSH `0.2.0-rc.2` 验证；所依赖的客户端模块契约（`dsh.client`、
  `conversation.composer.dock`、`dsh-client-ui-primitives` 的样式变量）可能随 DSH 版本变化。

---

## 开发

宿主半部是普通 ESM，浏览器半部是惰性 CommonJS bundle —— **没有构建步骤**，
`lib/index.js` 与 `lib/client.js` 就是发布产物。

```sh
node tools/check-client.mjs .   # 浏览器半部：注册 id、外部依赖、圆环与面板
node tools/check-host.mjs .     # 宿主半部：凭据解析、缓存、错误码
```

检查脚本强制的契约（每一条都曾真实导致过崩溃）：

- bundle 的注册 `id` **必须等于**包 `name`（不匹配会让外壳重取 bundle，重复注册会让整个 web boot 失败）；
- 浏览器 bundle 里每个 `require()` 必须属于平台基线（`react`、`react/jsx-runtime`、`react-dom`、
  `@deepseek-ai/cordis`）或在 `dsh.client.external` 中声明；
- 客户端 `apply()` 不能抛错：客户端条目激活失败会拖垮 web boot，所以注册被包在 try/catch 里并只记日志；
- 宿主半部声明 `inject: ['webServer']`，否则它会在 Web 服务器存在之前激活，路由被静默丢弃。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
