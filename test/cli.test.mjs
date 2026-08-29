import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeConfig, repositoryRoot, workOrder, fakeCall } from './helpers.mjs'

async function runCli(args, stdin = '') {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, 'src/cli.mjs'), ...args], {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('exit', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
    child.stdin.end(stdin)
  })
}

test('CLI validates and runs one stdin work order without persisting it', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-exec-cli-'))
  try {
    const configPath = resolve(directory, 'providers.json')
    await writeFile(configPath, `${JSON.stringify(fakeConfig())}\n`)
    const order = JSON.stringify(workOrder('cli', [fakeCall('echo', { value: 'cli-ok' })]))
    const validated = await runCli(['validate', '--config', configPath, '--work-order', '-'], order)
    assert.equal(validated.code, 0, validated.stderr)
    assert.equal(JSON.parse(validated.stdout).status, 'valid')
    const ran = await runCli(['run', '--config', configPath, '--work-order', '-'], order)
    assert.equal(ran.code, 0, ran.stderr)
    assert.equal(JSON.parse(ran.stdout).calls[0].result.value, 'cli-ok')
    const selection = JSON.stringify({
      schemaVersion: 'openadam.direct-contract-selection.v0.1',
      providerId: 'test.fake-capability',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        operationId: 'echo',
      },
    })
    const projected = await runCli(['project', '--config', configPath, '--selection', '-'], selection)
    assert.equal(projected.code, 0, projected.stderr)
    assert.equal(JSON.parse(projected.stdout).target.operationId, 'echo')
    const resolution = JSON.stringify({
      schemaVersion: 'openadam.direct-resolution-request.v0.1',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        operationId: 'echo',
      },
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
    })
    const resolved = await runCli(['resolve', '--config', configPath, '--requirement', '-'], resolution)
    assert.equal(resolved.code, 0, resolved.stderr)
    assert.equal(JSON.parse(resolved.stdout).status, 'eligible_for_this_request')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI rejects duplicate JSON keys with a stable host error', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-exec-cli-'))
  try {
    const configPath = resolve(directory, 'providers.json')
    await writeFile(configPath, `${JSON.stringify(fakeConfig())}\n`)
    const invalid = '{"schemaVersion":"openadam.direct-work-order.v0.1","id":"a","id":"b","calls":[]}'
    const result = await runCli(['run', '--config', configPath, '--work-order', '-'], invalid)
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).error.code, 'HOST_INVALID_JSON')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI serve and socket client keep a provider warm across processes', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-exec-cli-service-'))
  const configPath = resolve(directory, 'providers.json')
  const socketPath = resolve(directory, 'runtime.sock')
  const cliPath = resolve(repositoryRoot, 'src/cli.mjs')
  let service
  try {
    await writeFile(configPath, `${JSON.stringify(fakeConfig())}\n`)
    service = spawn(process.execPath, [cliPath, 'serve', '--config', configPath, '--socket', socketPath], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const ready = await new Promise((resolvePromise, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error('service readiness timed out')), 5000)
      service.once('error', reject)
      service.stdout.on('data', (chunk) => {
        text += chunk.toString('utf8')
        const newline = text.indexOf('\n')
        if (newline === -1) return
        clearTimeout(timer)
        resolvePromise(JSON.parse(text.slice(0, newline)))
      })
    })
    assert.equal(ready.status, 'ready')
    const firstOrder = JSON.stringify(workOrder('service-first', [fakeCall('one', { value: 'one' })]))
    const first = await runCli(['run', '--socket', socketPath, '--work-order', '-'], firstOrder)
    assert.equal(first.code, 0, first.stderr)
    assert.equal(JSON.parse(first.stdout).calls[0].session, 'cold')
    const secondOrder = JSON.stringify(workOrder('service-second', [fakeCall('two', { value: 'two' })]))
    const second = await runCli(['run', '--socket', socketPath, '--work-order', '-'], secondOrder)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(JSON.parse(second.stdout).calls[0].session, 'warm')
    const unsupportedResolution = await runCli([
      'resolve', '--socket', socketPath, '--requirement', '-',
    ], JSON.stringify({
      schemaVersion: 'openadam.direct-resolution-request.v0.1',
      target: { kind: 'mcp-tool', toolName: 'echo' },
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
    }))
    assert.equal(unsupportedResolution.code, 64)
    assert.equal(JSON.parse(unsupportedResolution.stdout).error.code, 'HOST_CLI_USAGE')
  } finally {
    if (service !== undefined && service.exitCode === null) {
      service.kill('SIGTERM')
      await new Promise((resolvePromise) => service.once('exit', resolvePromise))
    }
    await assert.rejects(() => access(socketPath), (error) => error.code === 'ENOENT')
    await rm(directory, { recursive: true, force: true })
  }
})
