#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { isMainThread, type MessagePort, workerData } from 'node:worker_threads'
import { Vault } from '../vault.ts'
import {
  runBackgroundJobInProcess,
  type BackgroundRunOptions,
} from './background-runner.ts'

interface WorkerInput {
  vaultPath: string
  id: string
  options: BackgroundRunOptions & {
    dryRun: boolean
    maxRuntimeMs: number
    maxJobRuntimeMs: number
  }
}

async function run(input: WorkerInput): Promise<ReturnType<typeof runBackgroundJobInProcess>> {
  const vault = new Vault(input.vaultPath)
  // The parent process owns user-facing progress/reporting. Per-job index
  // banners would otherwise make JSON and quiet CLI operation noisy.
  await vault.init({ quiet: true })
  try {
    return runBackgroundJobInProcess(vault, input.id, input.options)
  } finally {
    vault.shutdown()
  }
}

if (!isMainThread) {
  const data = workerData as { input: WorkerInput; port: MessagePort }
  run(data.input)
    .then(result => data.port.postMessage({ result }))
    .catch(err => data.port.postMessage({ error: err instanceof Error ? err.stack ?? err.message : String(err) }))
    .finally(() => data.port.close())
} else {
  const input = JSON.parse(readFileSync(0, 'utf-8')) as WorkerInput
  run(input)
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(err => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
