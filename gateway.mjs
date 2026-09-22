import http from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import httpProxy from 'http-proxy'

const publicPort = requiredPort(process.env.PORT)
const harnessPort = process.env.DSH_INTERNAL_PORT ? requiredPort(process.env.DSH_INTERNAL_PORT) : 3080
const harnessHost = '127.0.0.1'
const publicDomain = requiredText('RAILWAY_PUBLIC_DOMAIN')
const publicHostname = new URL(`https://${publicDomain}`).hostname
const gatewayCookieSecure = !['localhost', '127.0.0.1', '[::1]'].includes(publicHostname)
const accessUsername = requiredUsername('HARNESS_ACCESS_USERNAME')
const accessPassword = requiredPassword('HARNESS_ACCESS_PASSWORD')
const gatewayCookieName = 'dsh-gateway-session'
const gatewayCookieValue = createHmac('sha256', accessPassword)
  .update(`${accessUsername}\0${publicDomain}\0gateway-session-v1`)
  .digest('base64url')
const dshHome = process.env.DSH_HOME?.trim() || '/data/.dsh'
const workspaceDir = process.env.WORKSPACE_DIR?.trim() || '/data/workspace'
const appDir = dirname(fileURLToPath(import.meta.url))
const dshEntry = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const railwayPatch = join(appDir, 'railway.patch.yml')

await mkdir(dshHome, { recursive: true })
await mkdir(workspaceDir, { recursive: true })
process.chdir(workspaceDir)

let launchToken
let upstreamReady = false
let shuttingDown = false

const childEnv = { ...process.env, DSH_HOME: dshHome }
delete childEnv.HARNESS_ACCESS_PASSWORD
delete childEnv.HARNESS_ACCESS_USERNAME

const dsh = spawn(
  process.execPath,
  [
    dshEntry, 'web', '--patch', railwayPatch,
    '--no-open', '--port', String(harnessPort), '--trusted-host', publicDomain,
  ],
  { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
)

pipeHarnessOutput(dsh.stdout, process.stdout, line => {
  const match = line.match(/^dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/)
  if (match?.[1]) {
    launchToken = match[1]
    upstreamReady = true
    return 'dsh web: [authenticated launch URL redacted]\n'
  }
  return `${line}\n`
})
pipeHarnessOutput(dsh.stderr, process.stderr, line => `${redactToken(line)}\n`)

dsh.once('error', error => {
  console.error(`Harness failed to start: ${error.message}`)
  process.exitCode = 1
})
dsh.once('exit', (code, signal) => {
  upstreamReady = false
  if (!shuttingDown) {
    console.error(`Harness exited unexpectedly (code=${String(code)}, signal=${String(signal)})`)
    process.exit(code ?? 1)
  }
})

const proxy = httpProxy.createProxyServer({
  target: `http://${harnessHost}:${harnessPort}`,
  ws: true,
  xfwd: true,
  preserveHeaderKeyCase: true,
})

proxy.on('proxyReq', proxyReq => {
  proxyReq.setHeader('host', publicDomain)
  proxyReq.setHeader('x-forwarded-host', publicDomain)
  proxyReq.setHeader('x-forwarded-proto', 'https')
})
proxy.on('proxyReqWs', proxyReq => {
  proxyReq.setHeader('host', publicDomain)
  proxyReq.setHeader('origin', `https://${publicDomain}`)
  proxyReq.setHeader('x-forwarded-host', publicDomain)
  proxyReq.setHeader('x-forwarded-proto', 'https')
})
proxy.on('error', (error, _req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('DeepSeek Harness is starting. Please retry shortly.\n')
  }
  console.error(`Gateway proxy error: ${error.message}`)
})

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    const healthy = upstreamReady && await probeUpstream()
    res.writeHead(healthy ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ status: healthy ? 'ready' : 'starting' }))
    return
  }

  const requestUrl = new URL(req.url || '/', `https://${publicDomain}`)
  if (requestUrl.pathname === '/__gateway/login') {
    await handleGatewayLogin(req, res)
    return
  }

  const sessionAuthorized = hasGatewaySession(req.headers.cookie)
  const basicAuthorized = isBasicAuthorized(req.headers.authorization)
  if (!sessionAuthorized && !basicAuthorized) {
    if (req.method === 'GET' && acceptsHtml(req)) {
      res.writeHead(302, { location: '/__gateway/login', 'cache-control': 'no-store' })
      res.end()
    } else {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Authentication required.\n')
    }
    return
  }

  if (basicAuthorized && !sessionAuthorized) {
    res.writeHead(302, {
      location: req.url || '/',
      'set-cookie': gatewaySessionCookie(),
      'cache-control': 'no-store',
    })
    res.end()
    return
  }

  if (!upstreamReady || !launchToken) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3' })
    res.end('DeepSeek Harness is starting. Please retry shortly.\n')
    return
  }

  const cookie = req.headers.cookie || ''
  const cleanPath = requestUrl.pathname
  const suppliedLaunchToken = requestUrl.searchParams.get('token')
  if (suppliedLaunchToken !== null && suppliedLaunchToken !== launchToken) {
    res.writeHead(302, {
      location: `/?token=${encodeURIComponent(launchToken)}`,
      'cache-control': 'no-store',
    })
    res.end()
    return
  }
  const hasLaunchToken = suppliedLaunchToken !== null
  if ((cleanPath === '/' || cleanPath === '/index.html') && !cookie.includes('dsh-auth-') && !hasLaunchToken) {
    res.writeHead(302, {
      location: `/?token=${encodeURIComponent(launchToken)}`,
      'cache-control': 'no-store',
    })
    res.end()
    return
  }

  proxy.web(req, res)
})

server.on('upgrade', (req, socket, head) => {
  if ((!hasGatewaySession(req.headers.cookie) && !isBasicAuthorized(req.headers.authorization)) || !upstreamReady) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  proxy.ws(req, socket, head)
})

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`Railway gateway listening on port ${publicPort}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

function requiredText(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredUsername(name) {
  const value = requiredText(name)
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(value)) {
    throw new Error(`${name} must be 3-64 characters using letters, numbers, dot, underscore, or hyphen`)
  }
  return value
}

function requiredPassword(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  const length = [...value].length
  if (length < 12) throw new Error(`${name} must be at least 12 characters; 16 or more is recommended`)
  if (length > 256) throw new Error(`${name} must be no more than 256 characters`)
  return value
}

function requiredPort(value) {
  if (!value || !/^\d+$/.test(value)) throw new Error('PORT must be a numeric value')
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535')
  return port
}

function isBasicAuthorized(header) {
  if (!header?.startsWith('Basic ')) return false
  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return false
  }
  const expected = `${accessUsername}:${accessPassword}`
  const actualHash = createHash('sha256').update(decoded).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash)
}

function hasGatewaySession(cookieHeader) {
  const cookieValue = parseCookies(cookieHeader)[gatewayCookieName]
  if (!cookieValue) return false
  const actual = Buffer.from(cookieValue)
  const expected = Buffer.from(gatewayCookieValue)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function parseCookies(header) {
  const result = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return result
}

function gatewaySessionCookie() {
  const secure = gatewayCookieSecure ? '; Secure' : ''
  return `${gatewayCookieName}=${gatewayCookieValue}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=2592000`
}

function acceptsHtml(req) {
  return String(req.headers.accept || '').includes('text/html')
}

async function handleGatewayLogin(req, res) {
  if (req.method === 'GET') {
    sendLoginPage(res, 200)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' })
    res.end()
    return
  }

  let body
  try {
    body = await readBody(req, 8192)
  } catch {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('Request too large.\n')
    return
  }
  const form = new URLSearchParams(body)
  const supplied = `${form.get('username') || ''}:${form.get('password') || ''}`
  const expected = `${accessUsername}:${accessPassword}`
  const suppliedHash = createHash('sha256').update(supplied).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  if (!timingSafeEqual(suppliedHash, expectedHash)) {
    sendLoginPage(res, 401, 'Invalid username or password.')
    return
  }
  res.writeHead(303, {
    location: '/',
    'set-cookie': gatewaySessionCookie(),
    'cache-control': 'no-store',
  })
  res.end()
}

function sendLoginPage(res, status, error = '') {
  const errorMarkup = error ? `<p id="login-error" class="error" role="alert">${escapeHtml(error)}</p>` : ''
  const invalid = error ? ' aria-invalid="true" aria-describedby="login-error" autofocus' : ''
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · DeepSeek Harness</title>
<style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#f3f5f7;font:16px/1.5 system-ui,sans-serif}.card{width:min(92vw,420px);padding:32px;border:1px solid #2a2f3a;border-radius:16px;background:#141821;box-shadow:0 24px 80px #0008}h1{margin:0 0 8px;font-size:1.55rem}p{margin:0 0 24px;color:#aeb6c4}label{display:block;margin:14px 0 6px;font-weight:600}input{width:100%;padding:12px 14px;border:1px solid #3a4250;border-radius:9px;background:#0d1118;color:#fff;font:inherit}input:focus{outline:2px solid #4c8dff;outline-offset:2px}button{width:100%;margin-top:22px;padding:12px 16px;border:0;border-radius:9px;background:#276ef1;color:#fff;font:700 1rem system-ui;cursor:pointer}.error{margin:12px 0;color:#ff8d8d}</style></head>
<body><main class="card"><h1>DeepSeek Harness</h1><p>Sign in to access this private Railway deployment.</p>${errorMarkup}<form method="post" action="/__gateway/login" autocomplete="on"><label for="username">Username</label><input id="username" name="username" required autocomplete="username" value="${escapeHtml(accessUsername)}"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"${invalid}><button type="submit">Sign in</button></form></main></body></html>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
  })
  res.end(html)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

async function probeUpstream() {
  return await new Promise(resolve => {
    const request = http.request({
      host: harnessHost,
      port: harnessPort,
      path: '/',
      method: 'GET',
      headers: { host: publicDomain },
      timeout: 2000,
    }, response => {
      response.resume()
      resolve([200, 302, 401].includes(response.statusCode ?? 0))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
    request.end()
  })
}

function pipeHarnessOutput(stream, destination, transform) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) destination.write(transform(line))
  })
  stream.on('end', () => {
    if (pending) destination.write(transform(pending))
  })
}

function redactToken(line) {
  return line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  upstreamReady = false
  server.close(() => process.exit(0))
  dsh.kill(signal)
  setTimeout(() => process.exit(1), 15_000).unref()
}
