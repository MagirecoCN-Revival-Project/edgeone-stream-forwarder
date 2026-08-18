// 通用 /stream/ 转发器逻辑测试（Node 22+）
// 全部域名虚构（example.com / example.org），零真实域名。
import { handleRequest, isAllowedHost, rewriteEndpoint } from '../edge-functions/[[default]].js';
import assert from 'node:assert';

const WL = ['example.com'];
const ENV = { PROXY_WHITELIST: WL.join(',') };
// 网关域名也从请求推导，测试用虚构网关域
const GW_ORIGIN = 'https://gw.example.org';

// ── isAllowedHost(host, whitelist, selfHost) ──
assert(isAllowedHost('bootstrap.example.com', WL), 'subdomain match');
assert(isAllowedHost('core.example.com', WL), 'api host match');
assert(!isAllowedHost('evilexample.com', WL), 'boundary: no dot');
assert(!isAllowedHost('example.com.evil.com', WL), 'boundary: wrong side');
assert(!isAllowedHost('evil.com', WL), 'not in whitelist');
assert(!isAllowedHost('a@b.example.com', WL), 'userinfo rejected');
assert(!isAllowedHost('a%2fexample.com', WL), 'encoded slash rejected');
assert(isAllowedHost('example.com:8443', WL), 'port stripped ok');
assert(!isAllowedHost('core.example.com', []), 'empty whitelist denies all (fail-closed)');
// selfHost 推导的自环防护（不写死任何域名）
assert(!isAllowedHost('gw.example.org', WL, 'gw.example.org'), 'self host denied');
assert(!isAllowedHost('a.gw.example.org', WL, 'gw.example.org'), 'self host subdomain denied');
assert(isAllowedHost('bootstrap.example.com', WL, 'gw.example.org'), 'other host ok with selfHost');
// SSRF：私有/回环/保留 IP
assert(!isAllowedHost('127.0.0.1', WL), 'loopback denied');
assert(!isAllowedHost('localhost', WL), 'localhost denied');
assert(!isAllowedHost('10.0.0.1', WL), '10/8 denied');
assert(!isAllowedHost('172.16.5.5', WL), '172.16/12 denied');
assert(!isAllowedHost('192.168.1.1', WL), '192.168/16 denied');
assert(!isAllowedHost('169.254.1.1', WL), 'link-local denied');
assert(!isAllowedHost('::1', WL), 'ipv6 loopback denied');
assert(!isAllowedHost('fe80::1', WL), 'ipv6 link-local denied');
console.log('isAllowedHost: OK (22 cases)');

// ── rewriteEndpoint(ep, gwOrigin, whitelist, selfHost) ──
assert.equal(rewriteEndpoint('https://res.example.com/en', GW_ORIGIN, WL),
  'https://gw.example.org/res.example.com/en');
assert.equal(rewriteEndpoint('https://gw.example.org/res.example.com/en', GW_ORIGIN, WL), null, 'idempotent');
assert.equal(rewriteEndpoint('https://evil.com/en', GW_ORIGIN, WL), null, 'non-whitelist passthrough');
assert.equal(rewriteEndpoint('not-a-url', GW_ORIGIN, WL), null, 'bad url');
console.log('rewriteEndpoint: OK');

// ── handleRequest: 引导接口改写（网关域从请求推导）──
{
  const snaaBody = JSON.stringify({ message: 'snaa', response: { endpoint: 'https://res.example.com/en', max_threads: 4, version: 128 }, status: 200 });
  globalThis.fetch = async () => new Response(snaaBody, { status: 200, headers: { 'content-type': 'application/json' } });
  const req = new Request('https://gw.example.org/bootstrap.example.com/magica/api/snaa',
    { method: 'POST', body: '{"version":128}', headers: { 'content-type': 'application/json' } });
  const resp = await handleRequest(req, ENV);
  const body = await resp.text();
  assert.equal(resp.status, 200);
  assert(body.includes('https://gw.example.org/res.example.com/en'), 'endpoint rewritten to request origin');
  assert(body.includes('"version":128'), 'rest preserved');
  console.log('handleRequest/snaa: OK ->', body);
}

// ── handleRequest: 普通透传 ──
{
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://res.example.com/en/magica/resource?x=1', 'upstream url correct');
    return new Response('asset-list', { status: 200, headers: { 'content-type': 'text/plain', etag: 'W/"abc"' } });
  };
  const resp = await handleRequest(new Request('https://gw.example.org/res.example.com/en/magica/resource?x=1'), ENV);
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), 'asset-list');
  console.log('handleRequest/passthrough: OK');
}

// ── handleRequest: 白名单外 403 / 自环 403 / fail-closed ──
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  for (const u of [
    'https://gw.example.org/evil.example.net/foo',
    'https://gw.example.org/gw.example.org/foo',
    'https://gw.example.org/core.example.com/api/foo', // env 空白名单
  ]) {
    const resp = await handleRequest(new Request(u), u.includes('core.example.com') ? {} : ENV);
    assert.equal(resp.status, 403, u);
  }
  assert(!called, 'fetch never called for denied hosts');
  console.log('handleRequest/forbidden+self+fail-closed: OK');
}

// ── handleRequest: EXTRA_DENY_SUFFIXES 优先于白名单 ──
{
  const env = { PROXY_WHITELIST: 'example.com', EXTRA_DENY_SUFFIXES: 'blocked.example.com' };
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  const resp = await handleRequest(new Request('https://gw.example.org/x.blocked.example.com/foo'), env);
  assert.equal(resp.status, 403, 'extra deny wins over whitelist');
  assert(!called);
  console.log('handleRequest/extra-deny: OK');
}

// ── handleRequest: 上游失败 502 ──
{
  globalThis.fetch = async () => { throw new Error('connect timeout'); };
  const resp = await handleRequest(new Request('https://gw.example.org/bootstrap.example.com/magica/api/snaa'), ENV);
  assert.equal(resp.status, 502);
  console.log('handleRequest/upstream-error-502: OK');
}

// ── handleRequest: POST body 转发 ──
{
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://core.example.com/magica/api/anything');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"k":1}');
    return new Response('ok', { status: 200 });
  };
  const resp = await handleRequest(new Request('https://gw.example.org/core.example.com/magica/api/anything',
    { method: 'POST', body: '{"k":1}', headers: { 'content-type': 'application/json' } }), ENV);
  assert.equal(resp.status, 200);
  console.log('handleRequest/post-forward: OK');
}

// ── 加固：CONNECT / TRACE 拒绝 ──
// 注：undici 的 Request 构造器不允许 CONNECT/TRACE，这里用裸对象（handleRequest
// 只读 method/url/headers，方法检查在触碰 body 之前）。真实运行时 CONNECT 大多到
// 不了边缘函数，此拒是防御性兜底。
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  for (const m of ['CONNECT', 'TRACE']) {
    const fakeReq = { method: m, url: 'https://gw.example.org/core.example.com/foo', headers: new Headers() };
    const resp = await handleRequest(fakeReq, ENV);
    assert.equal(resp.status, 405, m + ' rejected');
  }
  assert(!called, 'fetch not called for disallowed methods');
  console.log('handleRequest/method-reject: OK');
}

// ── 加固：非 443 端口拒绝 / :443 剥掉转发 ──
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  const resp1 = await handleRequest(new Request('https://gw.example.org/core.example.com:8443/api/foo'), ENV);
  assert.equal(resp1.status, 400, 'non-443 port rejected');
  assert(!called, 'fetch not called for bad port');
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://core.example.com/api/foo', 'port stripped, default https');
    return new Response('ok', { status: 200 });
  };
  const resp2 = await handleRequest(new Request('https://gw.example.org/core.example.com:443/api/foo'), ENV);
  assert.equal(resp2.status, 200);
  console.log('handleRequest/port-guard: OK');
}

// ── 加固：路径注入（非法编码 / 编码控制字符）拒绝 ──
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('x'); };
  for (const p of ['/api/%zz/foo', '/api/%0d%0a/foo']) {
    const resp = await handleRequest(new Request('https://gw.example.org/core.example.com' + p), ENV);
    assert.equal(resp.status, 400, 'path injection rejected: ' + p);
  }
  assert(!called, 'fetch not called for injected paths');
  console.log('handleRequest/path-injection: OK');
}

// ── 加固：无 KV 时限流跳过（不崩、正常转发）──
{
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  const env = { PROXY_WHITELIST: 'example.com', RATE_LIMIT_PER_MIN: '5' };
  const resp = await handleRequest(new Request('https://gw.example.org/core.example.com/api/foo'), env);
  assert.equal(resp.status, 200, 'no kv binding, rate limit skipped');
  console.log('handleRequest/rate-limit-nokv: OK');
}

// ── 加固：超时配置存在 ──
{
  globalThis.fetch = async (url, init) => {
    assert(init.eo && init.eo.timeoutSetting && init.eo.timeoutSetting.readTimeout > 0, 'timeoutSetting present');
    return new Response('ok', { status: 200 });
  };
  const resp = await handleRequest(new Request('https://gw.example.org/core.example.com/api/foo'), ENV);
  assert.equal(resp.status, 200);
  console.log('handleRequest/timeout-config: OK');
}

console.log('\nALL GENERIC GATEWAY TESTS PASSED');
