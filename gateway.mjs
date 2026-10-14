import http from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SESSION_MS = 12 * 60 * 60 * 1000
const WINDOW_MS = 15 * 60 * 1000
const hash = value => createHash('sha256').update(value).digest()
const equal = (a, b) => timingSafeEqual(hash(a), hash(b))
const cookieValue = (header, name) => String(header || '').split(';')
  .map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)

export function readConfig(env = process.env) {
  const domain = env.RAILWAY_PUBLIC_DOMAIN?.trim()
  if (!domain) throw new Error('RAILWAY_PUBLIC_DOMAIN is required')
  const url = new URL(`https://${domain}`)
  if (url.host !== domain.toLowerCase() || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('RAILWAY_PUBLIC_DOMAIN must be a canonical host[:port] authority')
  }
  const username = env.HARNESS_ACCESS_USERNAME || ''
  const password = env.HARNESS_ACCESS_PASSWORD || ''
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error('HARNESS_ACCESS_USERNAME must be 3-64 letters, digits, dots, underscores or hyphens')
  if (!password || [...password].length > 256) throw new Error('HARNESS_ACCESS_PASSWORD must contain 1-256 characters')
  // Preserve existing deployments; new templates document a 16+ character secret.
  if ([...password].length < 12) console.warn('HARNESS_ACCESS_PASSWORD is shorter than the recommended minimum of 12 characters')
  const port = parsePort(env.PORT)
  const upstreamPort = parsePort(env.DSH_INTERNAL_PORT || '3080')
  if (port === upstreamPort) throw new Error('Public and internal ports must differ')
  const secure = !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return { domain: url.host, origin: `${secure ? 'https' : 'http'}://${url.host}`, secure, username, password, port, upstreamPort }
}

function parsePort(value) {
  if (!/^\d+$/.test(value || '') || +value < 1 || +value > 65535) throw new Error('Ports must be integers between 1 and 65535')
  return +value
}

// Dependency-free streaming proxy. All authentication headers are constructed here.
export function createGateway(config, { getLaunchToken, isRunning = () => true, now = Date.now } = {}) {
  const cookieName = config.secure ? '__Host-rakit-session' : 'rakit-session'
  const csrfName = config.secure ? '__Host-rakit-login' : 'rakit-login'
  const sessions = new Map()
  const csrfKey = randomBytes(32)
  const csrfSignature = value => createHmac('sha256', csrfKey).update(value).digest('base64url')
  const sockets = new Set()
  let attempts = 0
  let windowStart = now()
  let upstreamCookie = ''
  let readinessPromise
  let lastProbe = 0
  let healthy = false
  let closing = false

  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`
  function cleanup() {
    for (const [key, value] of sessions) if (value.expires <= now()) {
      for (const socket of value.sockets) socket.destroy()
      sessions.delete(key)
    }
  }
  const cleanupTimer = setInterval(cleanup, 30_000).unref()
  function session(req) {
    cleanup()
    const token = cookieValue(req.headers.cookie, cookieName)
    return token ? sessions.get(hash(token).toString('hex')) : undefined
  }
  function credentials(value) { return equal(value, `${config.username}:${config.password}`) }
  function rateAllowed() {
    if (now() - windowStart >= WINDOW_MS) { windowStart = now(); attempts = 0 }
    return attempts < 30
  }
  function basic(req) {
    const header = req.headers.authorization
    if (!header?.startsWith('Basic ')) return false
    if (!rateAllowed()) return false
    if (!credentials(Buffer.from(header.slice(6), 'base64').toString('utf8'))) { attempts++; return false }
    return true
  }
  function trusted(req, mutation = false) {
    if (req.headers.host?.toLowerCase() !== config.domain) return false
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false
    const origin = req.headers.origin
    return origin === undefined ? !mutation : origin === config.origin
  }
  function headers(req) {
    const result = { ...req.headers }
    for (const name of String(result.connection || '').toLowerCase().split(',').map(value => value.trim())) {
      if (name && !['upgrade', 'connection'].includes(name)) delete result[name]
    }
    // Never trust caller-supplied proxy identity, credentials, or upstream cookies.
    for (const name of Object.keys(result)) {
      if (['authorization', 'proxy-authorization', 'cookie', 'forwarded', 'x-real-ip', 'proxy-connection', 'keep-alive', 'te', 'trailer'].includes(name) || name.startsWith('x-forwarded-')) delete result[name]
    }
    result.host = config.domain
    result.cookie = upstreamCookie
    return result
  }
  function internal(path, authCookie = '') {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: config.upstreamPort, path,
        headers: { host: config.domain, cookie: authCookie }, timeout: 2000 }, response => {
        response.resume()
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }))
        response.once('error', reject)
      })
      request.on('timeout', () => request.destroy(new Error('upstream timeout')))
      request.on('error', reject)
    })
  }
  async function ready() {
    if (closing || !isRunning() || !getLaunchToken?.()) return false
    if (readinessPromise) return readinessPromise
    if (now() - lastProbe < 1000) return healthy
    readinessPromise = (async () => {
      try {
        if (!upstreamCookie) {
          const exchange = await internal(`/?token=${encodeURIComponent(getLaunchToken())}`)
          const cookies = exchange.headers['set-cookie'] || []
          const auth = cookies.filter(value => /^dsh-auth-[A-Za-z0-9_-]+=/.test(value)).map(value => value.split(';')[0])
          if (exchange.status !== 303 || auth.length !== 1) throw new Error('upstream authentication failed')
          upstreamCookie = auth[0]
        }
        healthy = (await internal('/', upstreamCookie)).status === 200
        if (!healthy) upstreamCookie = ''
      } catch { healthy = false; upstreamCookie = '' }
      lastProbe = now()
      return healthy
    })().finally(() => { readinessPromise = undefined })
    return readinessPromise
  }
  function reply(res, status, body = '', extra = {}) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra })
    res.end(body)
  }
  function issueSession(res) {
    cleanup()
    if (sessions.size >= 1024) return reply(res, 503, 'Session capacity reached.\n')
    const token = randomBytes(32).toString('base64url')
    sessions.set(hash(token).toString('hex'), { expires: now() + SESSION_MS, sockets: new Set() })
    reply(res, 303, '', { location: '/', 'set-cookie': cookie(cookieName, token, SESSION_MS / 1000) })
  }
  async function login(req, res) {
    if (req.method === 'GET') {
      cleanup()
      const body = `${now() + 600_000}.${randomBytes(32).toString('base64url')}`
      const token = `${body}.${csrfSignature(body)}`
      return reply(res, 200, loginPage(token), {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': cookie(csrfName, token, 600),
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
    }
    if (req.method !== 'POST') return reply(res, 405, '', { allow: 'GET, POST' })
    if (!trusted(req, true)) return reply(res, 403, 'Forbidden.\n')
    if (!rateAllowed()) return reply(res, 429, 'Please retry later.\n', { 'retry-after': String(Math.ceil((WINDOW_MS - (now() - windowStart)) / 1000)) })
    attempts++ // Shared account-wide limit: proxy/IP spoofing cannot bypass it.
    if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return reply(res, 415)
    let body
    try { body = await readBody(req, 8192) } catch { return reply(res, 413, 'Invalid request body.\n') }
    const form = new URLSearchParams(body)
    const csrf = form.get('csrf')
    cleanup()
    const [expiry, nonce, signature, extra] = String(csrf || '').split('.')
    if (!csrf || csrf !== cookieValue(req.headers.cookie, csrfName) || extra !== undefined || !nonce || !signature ||
      !Number.isSafeInteger(+expiry) || +expiry <= now() || +expiry > now() + 600_000 ||
      !equal(signature, csrfSignature(`${expiry}.${nonce}`))) return reply(res, 403, 'Forbidden.\n')
    if (!credentials(`${form.get('username') || ''}:${form.get('password') || ''}`)) return reply(res, 401, 'Invalid username or password. Reload the login page to retry.\n')
    issueSession(res)
  }
  function proxy(req, res) {
    const upstream = http.request({ host: '127.0.0.1', port: config.upstreamPort,
      method: req.method, path: req.url, headers: headers(req) }, response => {
      const responseHeaders = { ...response.headers }
      delete responseHeaders['set-cookie']
      // Upstream auth material must never reach browser URLs or cookies.
      if (/[?&]token=/i.test(responseHeaders.location || '')) {
        response.resume()
        return reply(res, 502, 'Invalid upstream redirect.\n')
      }
      res.writeHead(response.statusCode, { ...responseHeaders, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) reply(res, 502, 'Upstream unavailable.\n')
      else res.destroy()
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  const server = http.createServer((req, res) => {
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    void (async () => {
      if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        const status = await ready()
        return reply(res, status ? 200 : 503, JSON.stringify({ status: status ? 'ready' : 'starting' }), { 'content-type': 'application/json' })
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return reply(res, 400)
      const url = new URL(req.url, config.origin)
      if (!trusted(req)) return reply(res, 403, 'Forbidden.\n')
      if (url.pathname === '/__gateway/login') return await login(req, res)
      const active = session(req)
      const basicAuth = !active && basic(req)
      if (!active && !basicAuth) {
        const navigate = rateAllowed() && req.method === 'GET' && String(req.headers.accept).includes('text/html')
        return reply(res, navigate ? 302 : rateAllowed() ? 401 : 429, 'Authentication required.\n',
          navigate ? { location: '/__gateway/login' } : {})
      }
      if (basicAuth && req.method === 'GET' && String(req.headers.accept).includes('text/html')) return issueSession(res)
      // Browsers must supply exact Origin on all state changes; explicit Basic
      // clients without browser markers can still use the existing API workflow.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !trusted(req, !(basicAuth && !req.headers['sec-fetch-site'] && !req.headers.origin))) return reply(res, 403)
      if (url.pathname === '/__gateway/logout') {
        if (req.method !== 'POST') return reply(res, 405, '', { allow: 'POST' })
        if (active) {
          for (const socket of active.sockets) socket.destroy()
          sessions.delete(hash(cookieValue(req.headers.cookie, cookieName)).toString('hex'))
        }
        return reply(res, 303, '', { location: '/__gateway/login', 'set-cookie': cookie(cookieName, '', 0) })
      }
      if (url.searchParams.has('token')) return reply(res, 400, 'Launch tokens are not accepted by the public gateway.\n')
      if (!await ready()) return reply(res, 503, 'DeepSeek Harness is starting.\n', { 'retry-after': '3' })
      proxy(req, res)
    })().catch(() => { if (!res.headersSent) reply(res, 400, 'Invalid request.\n'); else res.destroy() })
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    void (async () => {
      const active = session(req)
      const authenticated = active || basic(req)
      const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      if (!authenticated) return reject('401 Unauthorized')
      // A browser WS always has Origin; reject missing Origin on cookie auth.
      if (!trusted(req, !!active) || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || new URL(req.url, config.origin).searchParams.has('token')) return reject('403 Forbidden')
      if (!await ready()) return reject('503 Service Unavailable')
      const upstream = http.request({ host: '127.0.0.1', port: config.upstreamPort, path: req.url, headers: headers(req), timeout: 5000 })
      upstream.on('upgrade', (response, peer, upstreamHead) => {
        upstream.setTimeout(0)
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([name]) => ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(name)).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) peer.write(head)
        const lifetime = setTimeout(() => socket.destroy(), active ? active.expires - now() : SESSION_MS).unref()
        active?.sockets.add(socket)
        socket.once('close', () => { clearTimeout(lifetime); active?.sockets.delete(socket); peer.destroy() })
        peer.on('error', () => socket.destroy())
        peer.once('close', () => socket.destroy())
        socket.pipe(peer).pipe(socket)
      })
      upstream.on('response', response => { response.resume(); reject('502 Bad Gateway') })
      upstream.on('timeout', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.end()
    })().catch(() => socket.destroy())
  })
  return { server, ready, async close() {
    closing = true
    clearInterval(cleanupTimer)
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  } }
}

async function readBody(req, limit) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const timer = setTimeout(() => { reject(new Error('body timeout')); req.destroy() }, 5000).unref()
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.resume() }
      else chunks.push(chunk)
    })
    req.once('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')) })
    req.once('error', error => { clearTimeout(timer); reject(error) })
    req.once('close', () => clearTimeout(timer))
  })
}

function loginPage(token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in - RAKIT DeepSeek Harness</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#f3f5f7;font:16px/1.5 system-ui,sans-serif}.card{width:min(92vw,420px);padding:32px;border:1px solid #2a2f3a;border-radius:16px;background:#141821;box-shadow:0 24px 80px #0008}h1{margin:0 0 8px;font-size:1.55rem}p{margin:0 0 24px;color:#aeb6c4}label{display:block;margin:14px 0 6px;font-weight:600}input{width:100%;padding:12px 14px;border:1px solid #3a4250;border-radius:9px;background:#0d1118;color:#fff;font:inherit}input:focus{outline:2px solid #4c8dff;outline-offset:2px}button{width:100%;margin-top:22px;padding:12px 16px;border:0;border-radius:9px;background:#276ef1;color:#fff;font:700 1rem system-ui;cursor:pointer}.error{margin:12px 0;color:#ff8d8d}</style></head><body><main class="card"><h1>RAKIT DeepSeek Harness</h1><p>Sign in to this private deployment.</p><form method="post" action="/__gateway/login"><input type="hidden" name="csrf" value="${token}"><label for="username">Username</label><input id="username" name="username" required autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"><button type="submit">Sign in</button></form></main></body></html>`
}

export function redactOutput(line, secrets = []) {
  let result = line.replace(/([?&]token=)[^\s&]+/gi, '$1[redacted]')
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]')
  return result
}

async function main() {
  const config = readConfig()
  process.umask(0o077)
  const dshHome = resolve(process.env.DSH_HOME?.trim() || '/data/.dsh')
  const workspace = resolve(process.env.WORKSPACE_DIR?.trim() || '/data/workspace')
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const appDir = dirname(fileURLToPath(import.meta.url))
  const env = { ...process.env, DSH_HOME: dshHome, WORKSPACE_DIR: workspace }
  delete env.HARNESS_ACCESS_USERNAME
  delete env.HARNESS_ACCESS_PASSWORD
  let launchToken
  let running = true
  let stopping = false
  const gateway = createGateway(config, { getLaunchToken: () => launchToken, isRunning: () => running })
  const child = spawn(process.execPath, [join(appDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'web', '--patch', join(appDir, 'railway.patch.yml'), '--no-open', '--host', '127.0.0.1',
    '--port', String(config.upstreamPort), '--trusted-host', config.domain],
  { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
  const secrets = [config.password, `${config.username}:${config.password}`, Buffer.from(`${config.username}:${config.password}`).toString('base64'),
    ...Object.entries(env).filter(([name]) => /(?:API_KEY|SECRET|PASSWORD|TOKEN)$/i.test(name)).map(([, value]) => value)]
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = ''
    stream.setEncoding('utf8')
    function output(line) {
      const match = line.match(/^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/)
      if (match) { launchToken = match[1]; secrets.push(launchToken) }
      destination.write(`${redactOutput(line, secrets)}\n`)
    }
    stream.on('data', chunk => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) output(line)
      // Never flush an unbounded partial line containing a possible secret.
      if (pending.length > 65536) pending = ''
    })
    stream.on('end', () => { if (pending) output(pending) })
  }
  async function stop(code, signal = 'SIGTERM') {
    if (stopping) return
    stopping = true
    running = false
    const deadline = setTimeout(() => { child.kill('SIGKILL'); process.exit(1) }, 10_000)
    const exited = !child.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))
    child.kill(signal)
    await Promise.all([gateway.close(), exited])
    clearTimeout(deadline)
    process.exitCode = code
  }
  child.once('error', () => { console.error('Harness failed to start'); void stop(1) })
  child.once('exit', () => { running = false; if (!stopping) { console.error('Harness exited unexpectedly'); void stop(1) } })
  gateway.server.on('error', () => { console.error('Gateway listener failed'); void stop(1) })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop(0, signal) })
  gateway.server.listen(config.port, '0.0.0.0', () => console.log(`RAKIT gateway listening on port ${config.port}`))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Gateway startup failed; check required configuration and volume permissions'); process.exitCode = 1 })
}
