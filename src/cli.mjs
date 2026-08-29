#!/usr/bin/env node
import process from 'node:process'
import { resolve } from 'node:path'
import { loadRuntimeConfig } from './config.mjs'
import { hostErrorPayload, HostError } from './errors.mjs'
import { requestDirectHost, MAX_HOST_CLIENT_REQUEST_BYTES } from './host-client.mjs'
import { DirectHostService } from './host-service.mjs'
import { decodeUtf8Strict, parseStrictJson, readStrictJsonFile } from './json.mjs'
import { DirectExecutionRuntime } from './runtime.mjs'
import { JsonlObservationSink } from './observations.mjs'

function usage() {
  return `Usage:
  openadam-direct-exec inspect (--config PATH | --socket PATH) [--pretty]
  openadam-direct-exec resolve --config PATH --requirement PATH|- [--pretty]
  openadam-direct-exec project (--config PATH | --socket PATH) --selection PATH|- [--pretty]
  openadam-direct-exec validate (--config PATH | --socket PATH) --work-order PATH|- [--pretty]
  openadam-direct-exec run --config PATH --work-order PATH|- [--observation-log PATH] [--pretty]
  openadam-direct-exec run --socket PATH --work-order PATH|- [--pretty]
  openadam-direct-exec serve --config PATH --socket PATH [--observation-log PATH] [--replace-stale-socket] [--max-connections N] [--pretty]`
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  if (!['inspect', 'resolve', 'project', 'validate', 'run', 'serve'].includes(command)) {
    throw new HostError('HOST_CLI_USAGE', usage())
  }
  const options = { command, pretty: false, replaceStaleSocket: false }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--pretty') {
      options.pretty = true
      continue
    }
    if (argument === '--replace-stale-socket') {
      if (options.replaceStaleSocket) throw new HostError('HOST_CLI_USAGE', '--replace-stale-socket may appear only once')
      options.replaceStaleSocket = true
      continue
    }
    if (['--config', '--socket', '--work-order', '--selection', '--requirement', '--max-connections', '--observation-log'].includes(argument)) {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('--')) throw new HostError('HOST_CLI_USAGE', `${argument} requires a value`)
      const key = {
        '--config': 'config',
        '--socket': 'socket',
        '--work-order': 'workOrder',
        '--selection': 'selection',
        '--requirement': 'requirement',
        '--max-connections': 'maxConnections',
        '--observation-log': 'observationLog',
      }[argument]
      if (options[key] !== undefined) throw new HostError('HOST_CLI_USAGE', `${argument} may appear only once`)
      options[key] = argument === '--max-connections' ? Number(value) : value
      index += 1
      continue
    }
    throw new HostError('HOST_CLI_USAGE', `Unknown argument ${argument}\n${usage()}`)
  }

  if (command === 'serve') {
    if (options.config === undefined || options.socket === undefined) {
      throw new HostError('HOST_CLI_USAGE', 'serve requires both --config and --socket')
    }
    if (options.workOrder !== undefined || options.selection !== undefined || options.requirement !== undefined) {
      throw new HostError('HOST_CLI_USAGE', '--work-order, --selection, and --requirement do not apply to serve')
    }
    return options
  }
  if ((options.config === undefined) === (options.socket === undefined)) {
    throw new HostError('HOST_CLI_USAGE', `${command} requires exactly one of --config or --socket`)
  }
  if (command === 'resolve' && options.socket !== undefined) {
    throw new HostError('HOST_CLI_USAGE', 'resolve is a config-backed v0.1 operation and does not use the v0.1 Socket protocol')
  }
  if (options.socket !== undefined && options.observationLog !== undefined) {
    throw new HostError('HOST_CLI_USAGE', '--observation-log is configured by the serving runtime, not a socket client')
  }
  if (options.observationLog !== undefined && command !== 'run') {
    throw new HostError('HOST_CLI_USAGE', '--observation-log applies only to config-backed run or serve')
  }
  if (options.replaceStaleSocket || options.maxConnections !== undefined) {
    throw new HostError('HOST_CLI_USAGE', '--replace-stale-socket and --max-connections apply only to serve')
  }
  if (command === 'project') {
    if (options.selection === undefined || options.workOrder !== undefined || options.requirement !== undefined) {
      throw new HostError('HOST_CLI_USAGE', 'project requires --selection and does not accept --work-order or --requirement')
    }
  } else if (options.selection !== undefined) {
    throw new HostError('HOST_CLI_USAGE', '--selection applies only to project')
  }
  if (command === 'resolve') {
    if (options.requirement === undefined || options.workOrder !== undefined) {
      throw new HostError('HOST_CLI_USAGE', 'resolve requires --requirement and does not accept --work-order')
    }
  } else if (options.requirement !== undefined) {
    throw new HostError('HOST_CLI_USAGE', '--requirement applies only to resolve')
  }
  if (['validate', 'run'].includes(command) && options.workOrder === undefined) {
    throw new HostError('HOST_CLI_USAGE', `${command} requires --work-order`)
  }
  if (['inspect', 'resolve', 'project'].includes(command) && options.workOrder !== undefined) {
    throw new HostError('HOST_CLI_USAGE', `--work-order does not apply to ${command}`)
  }
  return options
}

async function readStdinBounded(limit) {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > limit) throw new HostError('HOST_INPUT_TOO_LARGE', `stdin input exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return decodeUtf8Strict(Buffer.concat(chunks), 'stdin input')
}

async function readJsonInput(path, limit, label) {
  if (path !== '-') return await readStrictJsonFile(path, limit, label)
  const text = await readStdinBounded(limit)
  if (Buffer.byteLength(text) > limit) throw new HostError('HOST_INPUT_TOO_LARGE', `${label} exceeds ${limit} bytes`)
  return parseStrictJson(text, label)
}

function print(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`)
}

function clientTimeout(workOrder) {
  if (workOrder === undefined) return 30_000
  const longest = Math.max(10_000, ...workOrder.calls.map((call) => call.timeoutMs ?? 10_000))
  return Math.min(600_000, longest + 5_000)
}

async function waitForAbort(signal) {
  if (signal.aborted) return
  await new Promise((resolvePromise) => signal.addEventListener('abort', resolvePromise, { once: true }))
}

async function main() {
  let runtime
  let service
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.command === 'serve') {
      const config = await loadRuntimeConfig(options.config)
      runtime = new DirectExecutionRuntime(config, {
        ...(options.observationLog === undefined ? {} : {
          observationSink: new JsonlObservationSink(resolve(options.observationLog)),
        }),
      })
      service = new DirectHostService(runtime, {
        socketPath: options.socket,
        replaceStaleSocket: options.replaceStaleSocket,
        ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
      })
      print(await service.start(), options.pretty)
      await waitForAbort(controller.signal)
      return
    }

    if (options.socket !== undefined) {
      const workOrder = ['inspect', 'project'].includes(options.command)
        ? undefined
        : await readJsonInput(options.workOrder, MAX_HOST_CLIENT_REQUEST_BYTES, 'work order')
      const selection = options.command === 'project'
        ? await readJsonInput(options.selection, MAX_HOST_CLIENT_REQUEST_BYTES, 'contract selection')
        : undefined
      const output = await requestDirectHost({
        socketPath: options.socket,
        action: options.command,
        workOrder,
        selection,
        signal: controller.signal,
        timeoutMs: clientTimeout(workOrder),
      })
      print(output, options.pretty)
      if (output.status === 'invalid') process.exitCode = 2
      return
    }

    const config = await loadRuntimeConfig(options.config)
    runtime = new DirectExecutionRuntime(config, {
      ...(options.observationLog === undefined ? {} : {
        observationSink: new JsonlObservationSink(resolve(options.observationLog)),
      }),
    })
    if (options.command === 'inspect') {
      print(await runtime.inspectBindings(), options.pretty)
      return
    }
    if (options.command === 'resolve') {
      const requirement = await readJsonInput(
        options.requirement,
        config.limits.maxWorkOrderBytes,
        'resolution request',
      )
      print(await runtime.resolveBindings(requirement, { signal: controller.signal }), options.pretty)
      return
    }
    if (options.command === 'project') {
      const selection = await readJsonInput(options.selection, config.limits.maxWorkOrderBytes, 'contract selection')
      print(await runtime.projectContract(selection), options.pretty)
      return
    }
    const workOrder = await readJsonInput(options.workOrder, config.limits.maxWorkOrderBytes, 'work order')
    const output = options.command === 'validate'
      ? await runtime.validateWorkOrder(workOrder)
      : await runtime.runWorkOrder(workOrder, { signal: controller.signal })
    print(output, options.pretty)
    if (output.status === 'invalid') process.exitCode = 2
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    if (service !== undefined) await service.close()
    else await runtime?.close()
  }
}

main().catch((error) => {
  print({
    schemaVersion: 'openadam.direct-cli-error.v0.1',
    status: 'host_error',
    error: hostErrorPayload(error),
  }, false)
  process.exitCode = error?.code === 'HOST_CLI_USAGE' ? 64 : 1
})
