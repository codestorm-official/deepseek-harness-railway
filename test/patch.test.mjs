import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchUpstream } from '../patch-upstream.mjs'

const guard = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";'
test('compatibility patch preserves surrounding notices and fails closed on drift', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rakit-patch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageDir = name => join(root, 'node_modules/@deepseek-ai', name)
  for (const name of ['dsh', 'dsh-client-connection', 'dsh-client-ui-settings']) {
    await mkdir(join(packageDir(name), 'lib'), { recursive: true })
    await writeFile(join(packageDir(name), 'package.json'), JSON.stringify({ version: '0.1.7-alpha.1' }))
  }
  const client = join(packageDir('dsh-client-ui-settings'), 'lib/client.js')
  const original = `/* upstream copyright notice */\n${guard}\n/* other code */\n`
  await writeFile(client, original)
  await patchUpstream(root)
  assert.equal(await readFile(client, 'utf8'), original.replace(guard, 'const persistence = "host";'))
  await assert.rejects(patchUpstream(root), /expected exactly one/)
  for (const content of ['', `${guard}\n${guard}`]) {
    await writeFile(client, content)
    await assert.rejects(patchUpstream(root), /expected exactly one/)
    assert.equal(await readFile(client, 'utf8'), content)
  }
  for (const name of ['dsh', 'dsh-client-connection', 'dsh-client-ui-settings']) {
    const manifest = join(packageDir(name), 'package.json')
    await writeFile(client, original)
    await writeFile(manifest, JSON.stringify({ version: '0.2.0' }))
    await assert.rejects(patchUpstream(root), /unaudited|Refusing to patch/)
    assert.equal(await readFile(client, 'utf8'), original)
    await writeFile(manifest, JSON.stringify({ version: '0.1.7-alpha.1' }))
  }
})
