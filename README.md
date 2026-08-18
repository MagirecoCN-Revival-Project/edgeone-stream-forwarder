# edgeone-stream-forwarder

一个**通用**的 EdgeOne 边缘函数反向代理：把 `<网关域>/<host>/<path>` 请求
经边缘转发到 `https://<host>/<path>`，并把引导接口响应里的 `endpoint` 字段改写为
经网关的地址，让后续请求也走网关。任何项目部署后即可为自己的客户端请求做边缘加速。

## 它解决什么

客户端直连境外原站慢、不稳（跨境链路）。把这个函数部署在 EdgeOne（腾讯，大陆有
节点）上，客户端请求改为 `https://<你的网关域>/<原站域名>/<路径>`，由边缘
转发到原站——大陆玩家获得更快更稳的连接，且 edge 侧可加缓存、访问日志等。

**本函数不绑定任何具体项目**：代码里零域名、零业务逻辑，全靠环境变量配置。

## 目录结构

```
edge-functions/[[default]].js   转发函数（EdgeOne Makers Edge Functions，根 catch-all）
index.html                      网关探针页（noindex；页面=域名通，函数状态实时检测）
robots.txt                      拒绝所有爬虫（与 index.html 的 noindex 双管齐下）
tools/gateway.test.mjs          本地单元测试（Node 22+）
```

> Makers 是**全栈平台**：一个项目可同时托管静态资源与函数，**静态优先于函数路由**。
> Edge Functions 用 `edge-functions/` 目录；`[[default]].js` 是根 catch-all（匹配
> 任意层级路径），域名根（`/`、index.html、robots.txt）由静态托管兜住，其余路径
> 全部进入本函数。若用旧的 Pages Functions 部署，同一份代码放 `functions/[[default]].js`。
>
> **探针页怎么用**：浏览器打开 `<网关域>/`——页面加载说明 Makers 项目 + 域名 + DNS
> 都通；页面内会自动 fetch `/probe.invalid/__gateway_probe`，期待 403
> （静态服务器不代理 `/<host>/` 路径，403 只可能来自函数），据此显示网关函数是否在线。

## 部署

1. EdgeOne Pages 或 Makers 建项目（Edge Functions preset），关联本仓库，GitHub push 自动部署。
2. 绑你的域名（如 `gw.example.top`），开免费 TLS，DNS CNAME 指到平台默认域名。
3. **配环境变量**（EdgeOne 控制台）：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `PROXY_WHITELIST` | 是 | 允许代理的目标域名白名单，逗号分隔，后缀匹配（如 `a.example.com` 命中 `example.com`）。缺失或为空 → 全部拒绝（fail-closed）。 |
   | `EXTRA_DENY_SUFFIXES` | 否 | 额外硬排除后缀，逗号分隔（优先于白名单）。 |

   网关自身域名**不配置**：由请求 URL 推导，目标 host 命中网关域名即拒（防自环）。
4. 确认路由：`<你的网关域>/<host>/<path>` 进入函数（根 catch-all）；域名根 `/`
   与 index.html、robots.txt 走静态托管（静态优先）。

## 用法

客户端把请求从 `https://<原站域名>/<路径>` 改为
`https://<你的网关域>/<原站域名>/<路径>`（方法/请求头/请求体/query 原样转发，
响应 status/headers/body 流式透传，支持 Range/206 大文件）。

引导接口（可选特例）：路径以 `/magica/api/snaa` 结尾时，响应 JSON 里的
`"endpoint":"https://<host>/<路径>"` 会被改写成 `"https://<你的网关域>/<host>/<路径>"`，
让客户端后续请求自动走网关。

## 安全设计

- **白名单后缀匹配**（带点边界），白名单外一律 403，绝不代理任意站点。
- **自环防护**：目标 host 命中请求自身域名即拒（网关域不写死，运行时推导）。
- **SSRF 防护**：回环、私有、保留 IPv4/IPv6 段（10/8、127/8、172.16/12、192.168/16、
  169.254/16、0.0.0.0/8、::1、fe80:: 等）硬拒绝。
- host 段只许 `[A-Za-z0-9.-]`：拒 `@`（userinfo）、`%`（编码绕过）、`\`（路径逃逸）。
- 上游失败回 502（客户端可据非 2xx 走自己的直连回退）。
- 请求体上限 1MB 预检（413）。

## 本地测试

```bash
node tools/gateway.test.mjs   # Node 22+；覆盖白名单/边界/自环/SSRF/fail-closed/改写/透传/502/转发
```
