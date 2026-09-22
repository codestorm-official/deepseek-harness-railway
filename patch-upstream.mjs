import { chmod, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = dirname(fileURLToPath(import.meta.url))
const packageDir = join(appDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings')
const packageJsonPath = join(packageDir, 'package.json')
const clientPath = join(packageDir, 'lib', 'client.js')
const expectedVersion = '0.1.7-alpha.1'
const upstream = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";'
const railway = 'const persistence = "host";'

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
if (packageJson.version !== expectedVersion) {
  throw new Error(
    `Refusing to patch @deepseek-ai/dsh-client-ui-settings ${packageJson.version}; ` +
    `this wrapper is audited only for ${expectedVersion}.`,
  )
}

const source = await readFile(clientPath, 'utf8')
const occurrences = source.split(upstream).length - 1
if (occurrences !== 1) {
  throw new Error(
    `Refusing to patch ${clientPath}: expected exactly one audited persistence guard, found ${occurrences}.`,
  )
}

await chmod(clientPath, 0o644)
await writeFile(clientPath, source.replace(upstream, railway), 'utf8')
console.log('Enabled authenticated remote Host settings for the pinned DeepSeek Harness Web UI.')
