import fs from 'node:fs'
import path from 'node:path'
import { HostError } from './errors.mjs'

const DEFAULT_MAX_LOG_BYTES = 256 * 1024 * 1024

function assertOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log parent must be a real directory')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log parent must be owned by the current user')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log parent must be accessible only to its owner')
  }
}

export class JsonlObservationSink {
  constructor(filePath, options = {}) {
    if (!path.isAbsolute(filePath)) {
      throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log path must be absolute')
    }
    this.filePath = path.resolve(filePath)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 1024 * 1024 * 1024) {
      throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log byte limit is invalid')
    }
    assertOwnerDirectory(path.dirname(this.filePath))
    if (fs.existsSync(this.filePath)) {
      const info = fs.lstatSync(this.filePath)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log must be a regular non-symlinked file')
      }
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
        throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log must be owned by the current user')
      }
      fs.chmodSync(this.filePath, 0o600)
    }
  }

  async write(observation) {
    const line = `${JSON.stringify(observation)}\n`
    const lineBytes = Buffer.byteLength(line)
    const currentBytes = fs.existsSync(this.filePath) ? fs.lstatSync(this.filePath).size : 0
    if (currentBytes + lineBytes > this.maxBytes) {
      throw new HostError('HOST_OBSERVATION_LOG_FULL', 'Observation log reached its configured byte limit')
    }
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
    const descriptor = fs.openSync(this.filePath, flags, 0o600)
    try {
      const info = fs.fstatSync(descriptor)
      if (!info.isFile()) throw new HostError('HOST_OBSERVATION_LOG_INVALID', 'Observation log target is not a regular file')
      fs.writeFileSync(descriptor, line, { encoding: 'utf8' })
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(this.filePath, 0o600)
  }
}

