# edgeone-stream-forwarder

一个**通用**的 EdgeOne 边缘函数反向代理：把 `<网关域>/stream/<host>/<path>` 请求
经边缘转发到 `https://<host>/<path>`，并把引导接口响应里的 `endpoint` 字段改写为
经网关的地址，让后续请求也走网关。任何项目部署后即可为自己的客户端请求做边缘加速。

## 它解决什么

客户端直连境外原站慢、不稳（跨境链路）。把这个函数部署在 EdgeOne（腾讯，大陆有
节点）上，客户端请求改为 `https://<你的网关域>/stream/<原站域名>/<路径>`，由边缘
转发到原站——大陆玩家获得更快更稳的连接，且 edge 侧可加缓存、访问日志等。

**本函数不绑定任何具体项目**：代码里零域名、零业务逻辑，全靠环境变量配置。

## 目录结构

```
functions/stream/[[path]].js   转发函数（EdgeOne Pages Functions 约定）
tools/gateway.test.mjs         本地单元测试（Node 22+）
```

> 用 EdgeOne Makers 部署时把文件放到 `edge-functions/stream/[[path]].js`（同一份代码）。

## 部署

1. EdgeOne Pages 或 Makers 建项目（Edge Functions preset），关联本仓库，GitHub push 自动部署。
2. 绑你的域名（如 `gw.example.top`），开免费 TLS，DNS CNAME 指到平台默认域名。
3. **配环境变量**（EdgeOne 控制台）：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `PROXY_WHITELIST` | 是 | 允许代理的目标域名白名单，逗号分隔，后缀匹配（如 `a.example.com` 命中 `example.com`）。缺失或为空 → 全部拒绝（fail-closed）。 |
   | `EXTRA_DENY_SUFFIXES` | 否 | 额外硬排除后缀，逗号分隔（优先于白名单）。 |

   网关自身域名**不配置**：由请求 URL 推导，目标 host 命中网关域名即拒（防自环）。
4. 确认路由：`<你的网关域>/stream/*` 已注册到函数；`/stream/` 下不要放静态文件。

## 用法

客户端把请求从 `https://<原站域名>/<路径>` 改为
`https://<你的网关域>/stream/<原站域名>/<路径>`（方法/请求头/请求体/query 原样转发，
响应 status/headers/body 流式透传，支持 Range/206 大文件）。

引导接口（可选特例）：路径以 `/magica/api/snaa` 结尾时，响应 JSON 里的
`"endpoint":"https://<host>/<路径>"` 会被改写成 `"https://<你的网关域>/stream/<host>/<路径>"`，
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
