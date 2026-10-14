import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createGateway, readConfig, redactOutput } from '../gateway.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
const request = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { data += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('error', reject)
  req.end(body)
})

async function fixture(t) {
  const token = randomBytes(32).toString('base64url')
  const authCookie = `dsh-auth-fixture=${randomBytes(32).toString('base64url')}`
  const observed = []
  let available = true
  let launch = token
  let clock = Date.now()
  const upstream = http.createServer((req, res) => {
    observed.push({ url: req.url, headers: req.headers })
    if (!available) { res.writeHead(503); return res.end() }
    if (req.url === `/?token=${token}`) {
      res.writeHead(303, { 'set-cookie': `${authCookie}; HttpOnly; Path=/`, location: './' })
      return res.end()
    }
    if (req.headers.cookie !== authCookie) { res.writeHead(401); return res.end() }
    res.writeHead(200)
    res.end(req.url === '/' ? '<html>Harness</html>' : JSON.stringify(req.headers))
  })
  const peers = new Set()
  upstream.on('upgrade', (req, socket, head) => {
    observed.push({ url: req.url, headers: req.headers })
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
    if (req.headers.cookie !== authCookie) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    if (head.length) socket.write(head)
    socket.on('data', data => socket.write(data))
  })
  const upstreamPort = await listen(upstream)
  const config = readConfig({ PORT: '4000', DSH_INTERNAL_PORT: String(upstreamPort), RAILWAY_PUBLIC_DOMAIN: 'rakit.example',
    HARNESS_ACCESS_USERNAME: 'operator', HARNESS_ACCESS_PASSWORD: randomBytes(24).toString('base64url') })
  const gateway = createGateway(config, { getLaunchToken: () => launch, now: () => clock })
  const port = await listen(gateway.server)
  t.after(async () => { await gateway.close(); for (const peer of peers) peer.destroy(); await close(upstream) })
  const call = (path, options = {}) => request(port, path, { ...options, headers: { host: config.domain, ...options.headers } })
  async function login(password = config.password, extra = {}) {
    const page = await call('/__gateway/login')
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1]
    return call('/__gateway/login', { method: 'POST', body: new URLSearchParams({ csrf, username: config.username, password }).toString(),
      headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', cookie: page.headers['set-cookie'][0].split(';')[0], ...extra } })
  }
  return { call, login, observed, config, token, authCookie, port, gateway,
    advance: ms => { clock += ms }, available: value => { available = value }, launch: value => { launch = value } }
}

test('successful login issues unique secure sessions without disclosing username or token', async t => {
  const f = await fixture(t)
  const page = await f.call('/__gateway/login')
  assert.equal(page.status, 200)
  assert.ok(!page.body.includes(f.config.username))
  const a = await f.login(), b = await f.login()
  assert.equal(a.status, 303)
  assert.equal(a.headers.location, '/')
  const cookie = a.headers['set-cookie'][0]
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/)
  assert.notEqual(cookie, b.headers['set-cookie'][0])
  const root = await f.call('/', { headers: { cookie } })
  assert.equal(root.status, 200)
  assert.equal(root.headers['set-cookie'], undefined)
  assert.ok(!JSON.stringify(root).includes(f.token))
  assert.ok(!JSON.stringify(root).includes(f.authCookie))
})

test('invalid login and forged or expired session cannot access API', async t => {
  const f = await fixture(t)
  assert.equal((await f.login('incorrect')).status, 401)
  assert.equal((await f.call('/api/settings.describe')).status, 401)
  assert.equal((await f.call('/plugin/private')).status, 401)
  assert.equal((await f.call('/api/test', { headers: { cookie: '__Host-rakit-session=forged; dsh-auth-fake=forged' } })).status, 401)
  const login = await f.login()
  const cookie = login.headers['set-cookie'][0]
  assert.equal((await f.call('/api/test', { headers: { cookie } })).status, 200)
  f.advance(12 * 60 * 60 * 1000)
  assert.equal((await f.call('/api/test', { headers: { cookie } })).status, 401)
})

test('CSRF, hostile Host, same-site sibling Origin and token URLs are rejected', async t => {
  const f = await fixture(t)
  assert.equal((await f.login(f.config.password, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await f.login(f.config.password, { cookie: '' })).status, 403)
  assert.equal((await f.call('/__gateway/login', { headers: { host: 'evil.example' } })).status, 403)
  const cookie = (await f.login()).headers['set-cookie'][0]
  assert.equal((await f.call('/api/test', { method: 'POST', headers: { cookie } })).status, 403)
  assert.equal((await f.call('/api/test', { method: 'POST', headers: { cookie, origin: f.config.origin } })).status, 200)
  assert.equal((await f.call('/api/test', { headers: { cookie, origin: 'https://sibling.example', 'sec-fetch-site': 'same-site' } })).status, 403)
  assert.equal((await f.call('/?token=anything', { headers: { cookie } })).status, 400)
})

test('account-wide throttling covers form and Basic attempts despite spoofed proxy headers', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 30; i++) assert.equal((await f.login('incorrect', { 'x-forwarded-for': `192.0.2.${i}` })).status, 401)
  assert.equal((await f.login()).status, 429)
  const basic = Buffer.from(`${f.config.username}:${f.config.password}`).toString('base64')
  assert.equal((await f.call('/api/test', { headers: { authorization: `Basic ${basic}` } })).status, 429)
  f.advance(15 * 60 * 1000)
  assert.equal((await f.login()).status, 303)
})

test('gateway credentials, caller cookies and forged forwarding headers never reach upstream', async t => {
  const f = await fixture(t)
  const basic = Buffer.from(`${f.config.username}:${f.config.password}`).toString('base64')
  const res = await f.call('/api/test', { method: 'POST', headers: { authorization: `Basic ${basic}`, cookie: 'dsh-auth-forged=value; other=value',
    'x-forwarded-for': '192.0.2.1', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example', 'x-real-ip': '192.0.2.2' } })
  assert.equal(res.status, 200)
  const headers = JSON.parse(res.body)
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers['x-real-ip'], undefined)
  assert.equal(headers.cookie, f.authCookie)
  assert.equal(headers.host, f.config.domain)
})

test('readiness requires launch exchange AND authenticated 200, detects failure and recovers', async t => {
  const f = await fixture(t)
  f.launch(undefined)
  assert.equal((await f.call('/healthz', { headers: { host: 'healthcheck.railway.app' } })).status, 503)
  f.launch(f.token)
  assert.equal((await f.call('/healthz')).status, 200)
  f.available(false); f.advance(1001)
  assert.equal((await f.call('/healthz')).status, 503)
  f.available(true); f.advance(1001)
  assert.equal((await f.call('/healthz')).status, 200)
})

function upgrade(f, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/api/remote.mux', headers: {
      host: f.config.domain, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } })
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }))
    req.on('error', reject)
    req.end()
  })
}

test('WebSocket rejects unauthenticated and hostile/missing Origin; authenticated tunnel works', async t => {
  const f = await fixture(t)
  assert.equal((await upgrade(f)).status, 401)
  const cookie = (await f.login()).headers['set-cookie'][0]
  assert.equal((await upgrade(f, { cookie, origin: 'https://evil.example' })).status, 403)
  assert.equal((await upgrade(f, { cookie })).status, 403)
  const { status, socket } = await upgrade(f, { cookie, origin: f.config.origin })
  assert.equal(status, 101)
  const echoed = new Promise(resolve => socket.once('data', data => resolve(data.toString())))
  socket.write('tunnel test')
  assert.equal(await echoed, 'tunnel test')
  const disconnected = new Promise(resolve => socket.once('close', resolve))
  await f.call('/__gateway/logout', { method: 'POST', headers: { cookie, origin: f.config.origin } })
  socket.resume()
  await disconnected
  assert.equal((await f.call('/api/test', { headers: { cookie } })).status, 401)
})

test('configuration and log redaction fail safely', () => {
  const env = { PORT: '4000', RAILWAY_PUBLIC_DOMAIN: 'rakit.example', HARNESS_ACCESS_USERNAME: 'operator', HARNESS_ACCESS_PASSWORD: randomBytes(24).toString('hex') }
  for (const domain of ['rakit.example/path', 'user@rakit.example', 'rakit.example?query', '//evil.example', 'rakit.example:443']) {
    assert.throws(() => readConfig({ ...env, RAILWAY_PUBLIC_DOMAIN: domain }))
  }
  assert.throws(() => readConfig({ ...env, PORT: '3080' }))
  assert.throws(() => readConfig({ ...env, HARNESS_ACCESS_PASSWORD: '' }))
  assert.equal(redactOutput('URL /?token=secret&x=1 secret', ['secret']), 'URL /?token=[redacted]&x=1 [redacted]')
})

test('gateway restart invalidates existing sessions and bad launch exchange stays unready', async t => {
  const f = await fixture(t)
  const cookie = (await f.login()).headers['set-cookie'][0]
  const replacement = createGateway(f.config, { getLaunchToken: () => 'invalid-launch-token' })
  const port = await listen(replacement.server)
  t.after(() => replacement.close())
  assert.equal((await request(port, '/api/test', { headers: { host: f.config.domain, cookie } })).status, 401)
  assert.equal((await request(port, '/healthz')).status, 503)
})
