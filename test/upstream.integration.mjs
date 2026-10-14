// Real pinned Harness acceptance test. Requires Node 24, npm ci, and patch:upstream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'

async function unusedPort() {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('real Harness preserves workspace registration, settings and write-only credentials across restart', { timeout: 180_000 }, async t => {
  assert.ok(+process.versions.node.split('.')[0] >= 24, 'This acceptance test requires Node 24 or later')
  const base = resolve('.test-data')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'persistence-'))
  const home = join(root, '.dsh')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const secret = randomBytes(32).toString('base64url')
  const password = randomBytes(32).toString('base64url')
  const port = await unusedPort()
  let internalPort = await unusedPort()
  while (internalPort === port) internalPort = await unusedPort()
  const origin = `http://127.0.0.1:${port}`
  let child
  let output = ''
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000).unref()
    const [code] = await exited
    clearTimeout(timer)
    assert.equal(code, 0, 'Gateway must shut down cleanly')
  }
  t.after(async () => {
    try { await stop() } finally {
      // mkdtemp creates only within the explicitly resolved test directory.
      assert.ok(root.startsWith(base + (process.platform === 'win32' ? '\\' : '/')))
      await rm(root, { recursive: true, force: true })
    }
  })
  async function start() {
    child = spawn(process.execPath, ['gateway.mjs'], { env: { ...process.env,
      PORT: String(port), DSH_INTERNAL_PORT: String(internalPort), RAILWAY_PUBLIC_DOMAIN: `127.0.0.1:${port}`,
      HARNESS_ACCESS_USERNAME: 'operator', HARNESS_ACCESS_PASSWORD: password,
      DSH_HOME: home, WORKSPACE_DIR: workspace, DSH_TELEMETRY_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] })
    output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-65536) })
    child.on('error', () => {})
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail('Harness exited before readiness; inspect the pinned installation')
      try { if ((await fetch(`${origin}/healthz`)).status === 200) return } catch {}
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail('Harness did not become ready within 60 seconds; no secrets printed by this test')
  }
  async function login() {
    const page = await fetch(`${origin}/__gateway/login`)
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1]
    const response = await fetch(`${origin}/__gateway/login`, { method: 'POST', redirect: 'manual', headers: {
      origin, cookie: page.headers.getSetCookie()[0].split(';')[0], 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', password, csrf }) })
    assert.equal(response.status, 303)
    return response.headers.getSetCookie()[0].split(';')[0]
  }
  async function rpc(cookie, method, args = {}) {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomBytes(8).toString('hex'), method, payload: { args } }) })
    assert.equal(response.status, 200, `${method}: HTTP success`)
    const envelope = await response.json()
    assert.equal(envelope.result.ok, true, `${method}: RPC success (secrets omitted)`)
    assert.ok(!JSON.stringify(envelope).includes(secret), 'Credential must remain write-only')
    return envelope.result.value
  }
  await start()
  assert.equal((await fetch(`${origin}/api/settings/describe`, { method: 'POST' })).status, 401)
  let cookie = await login()
  const registered = await rpc(cookie, 'workspace/create', { request: { path: workspace } })
  await writeFile(join(workspace, 'restart-check.txt'), 'persistent workspace data\n')
  await rpc(cookie, 'credentials/set', { ref: 'RAKIT_TEST_API_KEY', value: secret })
  const settings = await rpc(cookie, 'settings/describe')
  assert.equal(settings.writable, true)
  const ns = settings.namespaces.find(item => typeof item.value?.enabled === 'boolean')
  assert.ok(ns, 'Pinned settings must expose a boolean enabled preference')
  const enabled = !ns.value.enabled
  await rpc(cookie, 'settings/update', { ns: ns.ns, patch: { enabled } })
  assert.ok((await readFile(join(home, '.credentials.yaml'), 'utf8')).includes(secret))
  const oldCookie = cookie
  await stop()
  await start()
  assert.equal((await fetch(`${origin}/api/settings/describe`, { method: 'POST', headers: { cookie: oldCookie, origin } })).status, 401)
  cookie = await login()
  assert.equal(await readFile(join(workspace, 'restart-check.txt'), 'utf8'), 'persistent workspace data\n')
  const existing = await rpc(cookie, 'workspace/create', { request: { path: workspace } })
  assert.equal(existing.created, false)
  assert.equal(existing.workspace.id, registered.workspace.id)
  const restored = await rpc(cookie, 'settings/describe')
  assert.equal(restored.namespaces.find(item => item.ns === ns.ns).value.enabled, enabled)
  const info = await rpc(cookie, 'credentials/describe', { refs: ['RAKIT_TEST_API_KEY'] })
  assert.equal(info.RAKIT_TEST_API_KEY.configured, true)
  assert.ok((await readFile(join(home, '.credentials.yaml'), 'utf8')).includes(secret))
  assert.ok(!output.includes(secret) && !output.includes(password), 'Logs must omit test credentials')
  assert.doesNotMatch(output, /[?&]token=[A-Za-z0-9_-]{20,}/)
})
