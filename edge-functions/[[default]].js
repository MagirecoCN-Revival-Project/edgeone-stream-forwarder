// ============================================================================
// EdgeOne 通用反向代理（边缘函数）
// ----------------------------------------------------------------------------
// 部署：edge-functions/[[default]].js（EdgeOne Makers 边缘函数，根 catch-all）
//       或 functions/[[default]].js（Pages Functions）——二选一
//
// 用途：把 <网关域>/<host>/<path> 请求经 EdgeOne 边缘转发到 https://<host>/<path>，
//       并把引导接口响应里的 endpoint 字段改写为经网关的地址，让后续请求也走网关。
//       网关域独占此转发用途，故无 /stream/ 之类前缀；域名根（/ 与 index.html、
//       robots.txt）由 Makers 静态托管，其余路径全部进入本函数。
//
// 配置（全环境变量注入，代码里不写任何域名）：
//   PROXY_WHITELIST      代理目标域名白名单，逗号分隔，后缀匹配。
//                        缺失或为空 → 全部拒绝（fail-closed，绝不代理一切）。
//   EXTRA_DENY_SUFFIXES  额外硬排除后缀，逗号分隔（可选，默认无）。
//   网关自身域名不配置：由请求 URL 推导，目标 host 命中网关域名即拒绝（防自环）。
//
// 安全：
//   - 白名单后缀匹配（example.com 命中 a.example.com 这类规则），白名单外一律 403。
//   - 网关自身域名（请求 Host）硬拒绝 → 自环防护。
//   - 回环 / 私有 / 保留 IP 段硬拒绝 → SSRF 防护。
//   - host 段只许域名合法字符（拒 @ % \ 等），IP 字面量天然过不了域名白名单。
// ============================================================================

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 平台请求体上限 1MB

// 逐跳头，一律不转发
const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

const SNAA_PATH_SUFFIX = "/magica/api/snaa";

// 后缀匹配：带点边界，a.example.com 命中 example.com，evilexample.com 不命中。
function suffixMatch(host, suffix) {
  return host === suffix || host.endsWith("." + suffix);
}

// IPv4 字面量是否落在回环 / 私有 / 保留段（SSRF 防护）。
function isPrivateIpv4(h) {
  const parts = h.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
  }
  const a = Number(parts[0]);
  if (a === 0 || a === 10 || a === 127) return true;              // 0.0.0.0/8, 10/8, 127/8
  if (a === 169 && Number(parts[1]) === 254) return true;         // link-local
  if (a === 172 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true; // 172.16/12
  if (a === 192 && Number(parts[1]) === 168) return true;         // 192.168/16
  return false;
}

// host 是否禁止代理。host 可能带 :port，先剥端口。
// selfHost = 网关自身域名（从请求推导）；命中即拒（防自环）。
function isAllowedHost(host, whitelist, selfHost) {
  let h = host;
  const pc = h.lastIndexOf(":");
  if (pc >= 0) {
    let allDigits = true;
    for (let i = pc + 1; i < h.length; i++) {
      const c = h.charCodeAt(i);
      if (c < 48 || c > 57) { allDigits = false; break; }
    }
    if (allDigits) h = h.substring(0, pc);
  }
  if (!h) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(h)) return false; // 拒 @（userinfo）/%（编码绕过）/\（路径逃逸）
  const lower = h.toLowerCase();
  if (isPrivateIpv4(lower)) return false;                        // SSRF：私有/回环/保留 IPv4
  if (lower === "::1" || lower.startsWith("fe80:")) return false; // IPv6 回环 / link-local
  if (lower === "localhost") return false;
  if (selfHost) {                                                // 自环：网关自身域名
    const sh = selfHost.toLowerCase();
    if (lower === sh || lower.endsWith("." + sh)) return false;
  }
  for (const suf of whitelist) {
    if (suffixMatch(lower, suf)) return true;
  }
  return false;
}

function loadWhitelist(env) {
  if (env && typeof env.PROXY_WHITELIST === "string") {
    return env.PROXY_WHITELIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function loadExtraDeny(env) {
  if (env && typeof env.EXTRA_DENY_SUFFIXES === "string") {
    return env.EXTRA_DENY_SUFFIXES.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

// 把上游 endpoint 值改写成经网关访问的地址；不该改时返回 null。
// gwOrigin 由请求 URL 推导（如 https://api.example.top），网关域不写死在代码里。
function rewriteEndpoint(ep, gwOrigin, whitelist, selfHost) {
  try {
    const u = new URL(ep);
    const gwHost = new URL(gwOrigin).hostname;
    if (u.hostname === gwHost) return null;                        // 幂等：已是网关地址
    if (!isAllowedHost(u.hostname, whitelist, selfHost)) return null; // 不在白名单，客户端直连
    return gwOrigin + "/" + u.host + u.pathname + u.search;
  } catch (e) {
    return null;
  }
}

// 核心处理函数
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const whitelist = loadWhitelist(env);
  const denyExtra = loadExtraDeny(env);
  const selfHost = url.hostname; // 网关自身域名 = 请求 Host

  // 根 catch-all：/<host>/<path> 直接按转发处理（无前缀）。
  // 根路径本身（/）与静态文件由 Makers 静态托管优先处理，到不了这里。
  let rest = url.pathname.replace(/^\/+/, "");
  if (!rest) return new Response("bad request: missing host", { status: 400 });

  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  let path = slash < 0 ? "" : rest.slice(slash);
  path = path.replace(/^\/+/, "/"); // 多斜杠归一个

  // 先 DENY（EXTRA_DENY_SUFFIXES），再 ALLOW（PROXY_WHITELIST），DENY 优先。
  if (denyExtra.some((d) => suffixMatch(host.toLowerCase(), d)) ||
      !isAllowedHost(host, whitelist, selfHost)) {
    return new Response("forbidden: host not in proxy whitelist", { status: 403 });
  }

  const cl = request.headers.get("content-length");
  if (cl && Number(cl) > MAX_REQUEST_BODY_BYTES) {
    return new Response("request body too large", { status: 413 });
  }

  // 转发请求头：去逐跳头 + host + accept-encoding（强制 identity）+ content-length（fetch 重算）
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.includes(key)) continue;
    if (key === "host") continue;
    if (key === "accept-encoding") continue;
    if (key === "content-length") continue;
    headers.append(k, v);
  }
  headers.set("Accept-Encoding", "identity");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  let upstream;
  try {
    upstream = await fetch("https://" + host + path + (url.search || ""), init);
  } catch (e) {
    return new Response("gateway upstream error: " + e.message,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.includes(key)) continue;
    respHeaders.append(k, v);
  }
  if (typeof upstream.headers.getSetCookie === "function") {
    for (const v of upstream.headers.getSetCookie()) respHeaders.append("Set-Cookie", v);
  }
  const enc = (upstream.headers.get("content-encoding") || "").toLowerCase();
  if (enc && enc !== "identity") {
    respHeaders.delete("content-encoding");
    respHeaders.delete("content-length");
  }

  // 3xx 的 Location 若指向白名单 host，改写成经网关（保持全程走网关）
  if (respHeaders.has("location")) {
    try {
      const loc = new URL(respHeaders.get("location"), "https://" + host);
      if (loc.hostname && isAllowedHost(loc.hostname, whitelist, selfHost)) {
        respHeaders.set("location", url.origin + "/" + loc.host + loc.pathname + loc.search);
      }
    } catch (e) { /* 相对/非法 Location，原样透传 */ }
  }

  // ── 引导接口特例：改写 endpoint 字段 ──
  if (url.pathname.replace(/\/+$/, "").endsWith(SNAA_PATH_SUFFIX)) {
    const text = await upstream.text();
    let rewritten = text;
    try {
      const obj = JSON.parse(text);
      if (obj && obj.response && typeof obj.response.endpoint === "string") {
        const neu = rewriteEndpoint(obj.response.endpoint, url.origin, whitelist, selfHost);
        if (neu && text.includes(obj.response.endpoint)) {
          rewritten = text.split(obj.response.endpoint).join(neu);
        }
      }
    } catch (e) { /* 非 JSON，原样透传 */ }

    if (rewritten !== text) {
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");
      respHeaders.set("content-length", String(new TextEncoder().encode(rewritten).byteLength));
    }
    return new Response(rewritten, { status: upstream.status, headers: respHeaders });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

// ═══ 模型 A：EdgeOne Makers / Pages Functions（文件路由）═══
export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}

// ═══ 仅供本地单元测试导出；EdgeOne 运行时忽略多余命名导出 ═══
export { handleRequest, isAllowedHost, rewriteEndpoint, suffixMatch };
