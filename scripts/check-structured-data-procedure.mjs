#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { digestFile } from '../src/json.mjs'
import { createLaunchSnapshot } from '../src/launch-snapshot.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import {
  buildPackagedBinding,
  procedureCall,
  processGroupMembers,
  providerConfig,
  quantiles,
  readyInput,
  timedRun,
  verifyDirectory,
  workOrder,
} from './structured-data-procedure-pilot.mjs'

async function measureCold(config, repetitions = 3) {
  const executionSamples = []
  const completeSamples = []
  const resultBytes = []
  for (let index = 0; index < repetitions; index += 1) {
    const completeStarted = performance.now()
    const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
    try {
      const measured = await timedRun(runtime, workOrder(`cold-${index}`, [
        procedureCall(`cold-${index}`, readyInput()),
      ]))
      assert.equal(measured.result.calls[0].status, 'ok')
      assert.equal(measured.result.calls[0].session, 'cold')
      executionSamples.push(measured.elapsedMs)
      resultBytes.push(measured.resultBytes)
    } finally {
      await runtime.close()
    }
    completeSamples.push(performance.now() - completeStarted)
  }
  return {
    executionsMs: quantiles(executionSamples),
    prepareRunCloseMs: quantiles(completeSamples),
    resultBytes: quantiles(resultBytes),
  }
}

async function inspectLaunchPlan(binding, packaged) {
  const snapshot = await createLaunchSnapshot(binding)
  try {
    assert.equal(snapshot.cwd, packaged.bindingRoot)
    assert.notEqual(snapshot.command, binding.adapterCommand)
    assert.equal(await digestFile(snapshot.command), binding.commandDigest)
    const environment = await snapshot.prepareEnvironment({ PATH: process.env.PATH })
    const firstPathEntry = environment.PATH.split(delimiter)[0]
    assert.notEqual(firstPathEntry, packaged.commands)
    assert.match(firstPathEntry, /openadam-direct-launch-.+\/filesystem\//u)
    return {
      businessCwdPreserved: true,
      commandUsesPrivateSnapshot: true,
      declaredExecutablePathUsesPrivateSnapshot: true,
      commandDigest: binding.commandDigest,
    }
  } finally {
    await snapshot.dispose()
  }
}

async function runCompletionAndFailures(runtime, packaged) {
  const withoutValidation = await timedRun(runtime, workOrder('without-validation', [
    procedureCall('without-validation', readyInput()),
  ]))
  assert.equal(
    withoutValidation.result.calls[0].status,
    'ok',
    JSON.stringify(withoutValidation.result.calls[0]),
  )
  assert.equal(withoutValidation.result.calls[0].session, 'cold')
  assert.equal(withoutValidation.result.calls[0].result.readiness, 'ready')
  assert.equal(Object.hasOwn(withoutValidation.result.calls[0].result, 'validation'), false)

  const passValidation = await timedRun(runtime, workOrder('constraints-pass', [
    procedureCall('constraints-pass', readyInput({
      assertions: [{ id: 'has-rows', type: 'row_count', min: 1 }],
    })),
  ]))
  assert.equal(passValidation.result.calls[0].status, 'ok')
  assert.equal(passValidation.result.calls[0].session, 'warm')
  assert.equal(passValidation.result.calls[0].result.readiness, 'ready')
  assert.equal(passValidation.result.calls[0].result.validation.valid, true)

  const failedConstraints = await timedRun(runtime, workOrder('constraints-failed', [
    procedureCall('constraints-failed', readyInput({
      assertions: [{ id: 'wrong-count', type: 'row_count', eq: 99 }],
    })),
  ]))
  assert.equal(failedConstraints.result.calls[0].status, 'ok')
  assert.equal(failedConstraints.result.calls[0].result.readiness, 'constraints-failed')
  assert.equal(failedConstraints.result.calls[0].result.validation.valid, false)

  const failures = {}
  for (const [name, input, code] of [
    ['missing', { path: 'fixtures/missing.json' }, 'SOURCE_NOT_FOUND'],
    ['invalid-json', { path: 'fixtures/invalid.json' }, 'DATA_NOT_PARSEABLE'],
    ['path-escape', { path: '../outside.json' }, 'PATH_FORBIDDEN'],
    ['inspection-failed', { path: 'fixtures/users.json', select: 'missing[*]' }, 'DATA_INSPECTION_FAILED'],
    ['validation-failed', readyInput({ schema: { type: 'bogus' } }), 'DATA_VALIDATION_FAILED'],
  ]) {
    const result = await runtime.runWorkOrder(workOrder(name, [procedureCall(name, input)]))
    assert.equal(result.calls[0].status, 'provider_error')
    assert.equal(result.calls[0].error.code, code)
    failures[name] = { status: result.calls[0].status, code, retryable: result.calls[0].error.retryable }
  }

  const fileBinary = resolve(packaged.bindingRoot, 'bin/file-vitals-capability')
  const unavailableBinary = `${fileBinary}.unavailable`
  let frozenIdentitySurvival
  let missingIdentity
  await rename(fileBinary, unavailableBinary)
  try {
    frozenIdentitySurvival = await runtime.runWorkOrder(workOrder('frozen-identity-survival', [
      procedureCall('frozen-identity-survival', readyInput()),
    ]))
    assert.equal(frozenIdentitySurvival.calls[0].status, 'ok')
    assert.equal(frozenIdentitySurvival.calls[0].session, 'warm')
    await runtime.replaceProvider('org.openadam.structured-data-preflight')
    missingIdentity = await runtime.runWorkOrder(workOrder('missing-identity-cold-start', [
      procedureCall('missing-identity-cold-start', readyInput()),
    ]))
    assert.equal(missingIdentity.calls[0].status, 'host_error')
    assert.equal(missingIdentity.calls[0].error.code, 'HOST_PROVIDER_REPLACED')
  } finally {
    await rename(unavailableBinary, fileBinary)
  }
  const providerRecovery = await runtime.runWorkOrder(workOrder('provider-recovery', [
    procedureCall('provider-recovery', readyInput()),
  ]))
  assert.equal(providerRecovery.calls[0].status, 'ok')
  assert.equal(providerRecovery.calls[0].session, 'cold')
  failures['identity-freeze'] = {
    warmSnapshotStatusAfterSourceRename: frozenIdentitySurvival.calls[0].status,
    coldStartStatusWhileSourceMissing: missingIdentity.calls[0].status,
    coldStartCodeWhileSourceMissing: missingIdentity.calls[0].error.code,
    recoveryStatus: providerRecovery.calls[0].status,
    recoverySession: providerRecovery.calls[0].session,
  }

  const invalidInput = await runtime.runWorkOrder(workOrder('invalid-input', [
    procedureCall('invalid-input', { path: 'fixtures/users.json', unexpected: true }),
  ]))
  assert.equal(invalidInput.calls[0].status, 'host_error')
  assert.equal(invalidInput.calls[0].error.code, 'HOST_INPUT_INVALID')
  failures.invalidInput = invalidInput.calls[0].error.code

  return {
    completion: {
      withoutValidation: { status: 'ok', readiness: 'ready', validationPresent: false },
      constraintsPass: { status: 'ok', readiness: 'ready', valid: true },
      constraintsFailed: { status: 'ok', readiness: 'constraints-failed', valid: false },
    },
    failures,
  }
}

async function runPartialAndInterruption(runtime) {
  const partial = await runtime.runWorkOrder(workOrder('partial', [
    procedureCall('partial-ready', readyInput()),
    procedureCall('partial-missing', { path: 'fixtures/missing.json' }),
  ]))
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.calls.map((call) => call.id), ['partial-ready', 'partial-missing'])
  assert.deepEqual(partial.calls.map((call) => call.status), ['ok', 'provider_error'])
  assert.deepEqual(partial.summary, { calls: 2, succeeded: 1, failed: 1 })

  const cancelledProcessGroup = runtime.sessionSnapshot()[0].pid
  assert.ok(Number.isInteger(cancelledProcessGroup))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const cancelled = await runtime.runWorkOrder(workOrder('cancelled', [
    procedureCall('cancelled', readyInput({
      assertions: Array.from({ length: 500 }, (_, index) => ({
        id: `row-count-${index}`, type: 'row_count', min: 0,
      })),
    })),
  ]), { signal: controller.signal })
  assert.equal(cancelled.calls[0].error.code, 'HOST_CANCELLED')
  assert.equal(runtime.sessionSnapshot()[0].pid, null)
  const remainingCancelled = await processGroupMembers(cancelledProcessGroup)
  assert.deepEqual(remainingCancelled, [])
  const cancelRecovery = await runtime.runWorkOrder(workOrder('cancel-recovery', [
    procedureCall('cancel-recovery', readyInput()),
  ]))
  assert.equal(cancelRecovery.calls[0].session, 'cold')

  const timedOutProcessGroup = runtime.sessionSnapshot()[0].pid
  assert.ok(Number.isInteger(timedOutProcessGroup))
  const timedOut = await runtime.runWorkOrder(workOrder('timed-out', [
    procedureCall('timed-out', readyInput({
      assertions: Array.from({ length: 500 }, (_, index) => ({
        id: `timeout-row-count-${index}`, type: 'row_count', min: 0,
      })),
    }), 10),
  ]))
  assert.equal(timedOut.calls[0].error.code, 'HOST_TIMEOUT')
  assert.equal(runtime.sessionSnapshot()[0].pid, null)
  const remainingTimedOut = await processGroupMembers(timedOutProcessGroup)
  assert.deepEqual(remainingTimedOut, [])
  const timeoutRecovery = await runtime.runWorkOrder(workOrder('timeout-recovery', [
    procedureCall('timeout-recovery', readyInput()),
  ]))
  assert.equal(timeoutRecovery.calls[0].session, 'cold')

  return {
    partial: {
      status: partial.status,
      callStatuses: partial.calls.map((call) => call.status),
      summary: partial.summary,
    },
    cancellationRecovery: {
      cancelledCode: cancelled.calls[0].error.code,
      processGroupMembersAfterCancel: remainingCancelled.length,
      recoveryStatus: cancelRecovery.calls[0].status,
      recoverySession: cancelRecovery.calls[0].session,
    },
    timeoutRecovery: {
      timeoutCode: timedOut.calls[0].error.code,
      processGroupMembersAfterTimeout: remainingTimedOut.length,
      recoveryStatus: timeoutRecovery.calls[0].status,
      recoverySession: timeoutRecovery.calls[0].session,
    },
  }
}

async function runBudget(packaged) {
  const prepared = await prepareRuntimeConfig(providerConfig(
    packaged.bindingRoot,
    packaged.identityFiles,
    { limits: { maxProviderResponseBytes: 1024 } },
  ))
  const runtime = new DirectExecutionRuntime(prepared)
  try {
    const limited = await runtime.runWorkOrder(workOrder('limited-output', [
      procedureCall('limited-output', readyInput({
        assertions: Array.from({ length: 20 }, (_, index) => ({
          id: `row-count-${index}`, type: 'row_count', min: 0,
        })),
      })),
    ]))
    assert.equal(limited.calls[0].error.code, 'HOST_PROVIDER_RESPONSE_TOO_LARGE')
    const recovery = await runtime.runWorkOrder(workOrder('budget-recovery', [
      procedureCall('budget-recovery', { path: 'fixtures/missing.json' }),
    ]))
    assert.equal(recovery.calls[0].error.code, 'SOURCE_NOT_FOUND')
    assert.equal(recovery.calls[0].session, 'cold')
    return {
      limitBytes: 1024,
      code: limited.calls[0].error.code,
      recovery: recovery.calls[0].error.code,
      recoverySession: recovery.calls[0].session,
    }
  } finally {
    await runtime.close()
  }
}

async function main() {
  const temporaryRoot = await realpath(await mkdtemp(resolve(tmpdir(), 'direct-structured-preflight-')))
  const priorPath = process.env.PATH
  let runtime
  try {
    const packaged = await buildPackagedBinding(temporaryRoot)
    process.env.PATH = `${packaged.commands}:${priorPath ?? ''}`
    const config = providerConfig(packaged.bindingRoot, packaged.identityFiles)
    const preparedStarted = performance.now()
    const prepared = await prepareRuntimeConfig(config)
    const bindingPreparationMs = performance.now() - preparedStarted
    const binding = prepared.providers.get('org.openadam.structured-data-preflight')
    assert.ok(binding, 'prepared Procedure binding is absent')
    const launchPlan = await inspectLaunchPlan(binding, packaged)
    runtime = new DirectExecutionRuntime(prepared)
    const snapshotBefore = runtime.sessionSnapshot()[0]
    assert.equal(snapshotBefore.present, false)
    assert.equal(binding.identityDigests.length, packaged.identityFiles.length)

    const contract = await runCompletionAndFailures(runtime, packaged)
    const inspected = await runtime.inspectBindings()
    assert.equal(inspected.providers[0].observation, 'live_call_response_observed')
    assert.equal(inspected.providers[0].live.providerVersion, '0.1.0')
    assert.equal(inspected.providers[0].live.procedureVersion, '0.3.0')
    const interruption = await runPartialAndInterruption(runtime)

    const warmSamples = []
    const warmBytes = []
    for (let index = 0; index < 10; index += 1) {
      const measured = await timedRun(runtime, workOrder(`warm-${index}`, [
        procedureCall(`warm-${index}`, readyInput()),
      ]))
      assert.equal(measured.result.calls[0].status, 'ok')
      assert.equal(measured.result.calls[0].session, 'warm')
      warmSamples.push(measured.elapsedMs)
      warmBytes.push(measured.resultBytes)
    }
    await runtime.close()
    runtime = undefined

    const report = {
      schemaVersion: 'openadam.direct-structured-data-procedure-observation.v0.1',
      observedAt: new Date().toISOString(),
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      scope: {
        procedure: 'org.openadam.structured-data.preflight@0.3.0',
        implementation: 'org.openadam.structured-data-preflight@0.1.0',
        modelCallsInsideRuntime: 0,
        agentRoute: 'not_run',
        installedHost: 'not_run',
        formalSlo: null,
        boundary: 'Temporary packaged-provider compatibility binding. Python provider code comes from rebuilt wheels but third-party dependencies come from current sibling virtual environments; this does not alter or establish the tracked Provider manifest as an installed-host binding.',
      },
      packageArtifacts: packaged.packageArtifacts,
      binding: {
        statusBeforeCall: snapshotBefore.present ? 'session_present' : 'session_absent',
        statusAfterCall: inspected.providers[0].observation,
        bindingDigest: binding.bindingDigest,
        profileDigest: binding.profileDigest,
        implementationManifestDigest: binding.implementationManifestDigest,
        identityFiles: binding.identityDigests,
        stageBindings: packaged.stageBindings,
        launchPlan,
        preparationMs: bindingPreparationMs,
      },
      ...contract,
      ...interruption,
      budget: await runBudget(packaged),
      latency: {
        coldDirect: await measureCold(config),
        warmDirect: {
          executionsMs: quantiles(warmSamples),
          resultBytes: quantiles(warmBytes),
        },
        note: 'Current-machine observations only. Artifact build time is excluded from execution latency, and no SLO is declared.',
      },
    }
    await mkdir(verifyDirectory, { recursive: true })
    await writeFile(
      resolve(verifyDirectory, 'structured-data-procedure.latest.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    process.stdout.write(`${JSON.stringify({
      procedure: report.scope.procedure,
      completion: report.completion,
      failures: report.failures,
      partial: report.partial,
      cancellationRecovery: report.cancellationRecovery,
      timeoutRecovery: report.timeoutRecovery,
      budget: report.budget,
      coldDirectMs: report.latency.coldDirect.executionsMs,
      warmDirectMs: report.latency.warmDirect.executionsMs,
      report: '.verify/structured-data-procedure.latest.json',
    })}\n`)
  } finally {
    if (runtime !== undefined) await runtime.close()
    process.env.PATH = priorPath
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
