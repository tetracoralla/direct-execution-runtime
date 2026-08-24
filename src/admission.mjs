import { HostError } from './errors.mjs'

export class AdmissionController {
  #active = 0
  #queueGroups = new Map()
  #groupOrder = []
  #queued = 0

  constructor({ maxConcurrentCalls, maxQueuedCalls }) {
    this.maxConcurrentCalls = maxConcurrentCalls
    this.maxQueuedCalls = maxQueuedCalls
  }

  snapshot() {
    return {
      active: this.#active,
      queued: this.#queued,
      queuedGroups: this.#groupOrder.length,
      maxConcurrentCalls: this.maxConcurrentCalls,
      maxQueuedCalls: this.maxQueuedCalls,
    }
  }

  async acquire({ signal, deadlineAt, fairnessKey = 'default' }) {
    if (signal?.aborted) throw new HostError('HOST_CANCELLED', 'Call was cancelled before admission')
    if (Date.now() >= deadlineAt) throw new HostError('HOST_TIMEOUT', 'Call deadline expired before admission')
    if (this.#active < this.maxConcurrentCalls && this.#queued === 0) {
      this.#active += 1
      return this.#releaseHandle()
    }
    if (this.#queued >= this.maxQueuedCalls) {
      throw new HostError('HOST_OVERLOADED', 'Direct execution admission queue is full', {
        retryable: true,
        details: this.snapshot(),
      })
    }

    return await new Promise((resolve, reject) => {
      const queuedAt = performance.now()
      const groupKey = String(fairnessKey)
      const entry = { resolve, reject, signal, deadlineAt, queuedAt, groupKey, timer: undefined, abort: undefined }
      const remove = () => {
        const group = this.#queueGroups.get(groupKey)
        if (group === undefined) return
        const at = group.indexOf(entry)
        if (at === -1) return
        group.splice(at, 1)
        this.#queued -= 1
        if (group.length === 0) {
          this.#queueGroups.delete(groupKey)
          this.#groupOrder = this.#groupOrder.filter((key) => key !== groupKey)
        }
      }
      entry.abort = () => {
        remove()
        clearTimeout(entry.timer)
        reject(new HostError('HOST_CANCELLED', 'Call was cancelled while queued'))
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      entry.timer = setTimeout(() => {
        remove()
        signal?.removeEventListener('abort', entry.abort)
        reject(new HostError('HOST_TIMEOUT', 'Call deadline expired while queued'))
      }, Math.max(1, deadlineAt - Date.now()))
      let group = this.#queueGroups.get(groupKey)
      if (group === undefined) {
        group = []
        this.#queueGroups.set(groupKey, group)
        this.#groupOrder.push(groupKey)
      }
      group.push(entry)
      this.#queued += 1
    })
  }

  #nextQueued() {
    while (this.#groupOrder.length > 0) {
      const groupKey = this.#groupOrder.shift()
      const group = this.#queueGroups.get(groupKey)
      if (group === undefined || group.length === 0) continue
      const entry = group.shift()
      this.#queued -= 1
      if (group.length === 0) this.#queueGroups.delete(groupKey)
      else this.#groupOrder.push(groupKey)
      return entry
    }
    return undefined
  }

  #releaseHandle(queueMs = 0) {
    let released = false
    return {
      queueMs,
      release: () => {
        if (released) return
        released = true
        const next = this.#nextQueued()
        if (next === undefined) {
          this.#active -= 1
          return
        }
        clearTimeout(next.timer)
        next.signal?.removeEventListener('abort', next.abort)
        next.resolve(this.#releaseHandle(performance.now() - next.queuedAt))
      },
    }
  }
}
