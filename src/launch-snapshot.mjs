import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'
import { HostError } from './errors.mjs'

const COPY_BUFFER_BYTES = 64 * 1024

function addDirectoryAndParents(paths, path) {
  let current = path
  while (true) {
    paths.add(current)
    if (current === '') return
    const parent = dirname(current)
    current = parent === '.' ? '' : parent
  }
}

function addBoundFile(files, path, declaration) {
  if (path === '' || path === '.') {
    throw new HostError('HOST_PROVIDER_REPLACED', 'Provider launch identity cannot replace its root directory', {
      retryable: true,
    })
  }
  const existing = files.get(path)
  if (
    existing !== undefined &&
    (existing.sourcePath !== declaration.sourcePath || existing.digest !== declaration.digest)
  ) {
    throw new HostError('HOST_PROVIDER_REPLACED', `Provider launch identities conflict at ${path}`, {
      retryable: true,
    })
  }
  files.set(path, {
    ...declaration,
    executable: declaration.executable === true || existing?.executable === true,
  })
}

async function copyVerifiedFile(sourcePath, destinationPath, expectedDigest, executable) {
  const source = await open(sourcePath, 'r')
  let destination
  try {
    const sourceInfo = await source.stat()
    if (!sourceInfo.isFile()) {
      throw new HostError('HOST_PROVIDER_REPLACED', 'Provider launch identity is no longer a regular file', {
        retryable: true,
      })
    }
    const destinationExecutable = executable || (sourceInfo.mode & 0o111) !== 0
    destination = await open(destinationPath, 'wx', destinationExecutable ? 0o500 : 0o400)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    await destination.chmod(destinationExecutable ? 0o500 : 0o400)
    const destinationInfo = await destination.stat()
    const observedDigest = `sha256:${hash.digest('hex')}`
    if (
      !destinationInfo.isFile() ||
      destinationInfo.nlink !== 1 ||
      destinationInfo.size !== position ||
      observedDigest !== expectedDigest
    ) {
      throw new HostError('HOST_PROVIDER_REPLACED', 'Provider launch identity changed while its private snapshot was created', {
        retryable: true,
        details: { expectedDigest, observedDigest },
      })
    }
  } finally {
    await destination?.close().catch(() => {})
    await source.close().catch(() => {})
  }
}

function stagedArguments(args, references, stagedBySourcePath) {
  return args.map((argument, index) => {
    const reference = references[index]
    if (reference === undefined || reference === null) return argument
    const staged = stagedBySourcePath.get(reference.sourcePath)
    if (staged === undefined) {
      throw new HostError('HOST_PROVIDER_REPLACED', 'Provider identity argument has no staged copy', {
        retryable: true,
      })
    }
    if (reference.kind === 'value') return staged
    const separator = argument.indexOf('=')
    if (separator === -1) {
      throw new HostError('HOST_PROVIDER_REPLACED', 'Provider identity argument changed shape', {
        retryable: true,
      })
    }
    return `${argument.slice(0, separator + 1)}${staged}`
  })
}

async function prepareEnvironment(environment, cwd, stagedDirectories) {
  const prepared = { ...environment, PWD: cwd }
  for (const key of ['PATH', 'Path']) {
    if (typeof prepared[key] !== 'string') continue
    const entries = []
    for (const entry of prepared[key].split(delimiter)) {
      if (entry.length === 0 || !isAbsolute(entry)) {
        entries.push(entry)
        continue
      }
      const canonical = await realpath(entry).catch(() => null)
      const staged = stagedDirectories.get(resolve(entry)) ?? stagedDirectories.get(canonical)
      entries.push(staged ?? entry)
    }
    prepared[key] = entries.join(delimiter)
  }
  return prepared
}

function launchFields(binding) {
  return binding.transport === 'mcp-stdio'
    ? { command: binding.command, args: binding.args, cwd: binding.cwd }
    : { command: binding.adapterCommand, args: binding.adapterArgs, cwd: binding.adapterCwd }
}

async function mirrorSparseTree(sourceRoot, destinationRoot, boundFiles, materializedDirectories) {
  const mirrorDirectory = async (directoryPath) => {
    const sourceDirectory = resolve(sourceRoot, directoryPath)
    const destinationDirectory = resolve(destinationRoot, directoryPath)
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    const seen = new Set()
    for (const entry of entries) {
      const childPath = directoryPath === '' ? entry.name : `${directoryPath}/${entry.name}`
      seen.add(childPath)
      const sourcePath = resolve(sourceDirectory, entry.name)
      const destinationPath = resolve(destinationDirectory, entry.name)
      if (materializedDirectories.has(childPath)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          throw new HostError('HOST_PROVIDER_REPLACED', `Provider launch directory changed at ${childPath}`, {
            retryable: true,
          })
        }
        await mkdir(destinationPath, { mode: 0o700 })
        await mirrorDirectory(childPath)
      } else if (boundFiles.has(childPath)) {
        const declaration = boundFiles.get(childPath)
        await copyVerifiedFile(
          declaration.sourcePath,
          destinationPath,
          declaration.digest,
          declaration.executable,
        )
      } else {
        await symlink(sourcePath, destinationPath, entry.isDirectory() ? 'dir' : 'file')
      }
    }
    for (const childPath of materializedDirectories) {
      if (dirname(childPath) === (directoryPath || '.') && childPath !== '' && !seen.has(childPath)) {
        throw new HostError('HOST_PROVIDER_REPLACED', `Provider launch directory disappeared at ${childPath}`, {
          retryable: true,
        })
      }
    }
    for (const childPath of boundFiles.keys()) {
      if (dirname(childPath) === (directoryPath || '.') && !seen.has(childPath)) {
        throw new HostError('HOST_PROVIDER_REPLACED', `Provider launch identity disappeared at ${childPath}`, {
          retryable: true,
        })
      }
    }
  }
  await mirrorDirectory('')
}

export async function createLaunchSnapshot(binding) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'openadam-direct-launch-'))
  const filesystemRoot = resolve(temporaryRoot, 'filesystem')
  let disposal
  const dispose = async () => {
    if (disposal === undefined) {
      const pending = rm(temporaryRoot, { recursive: true, force: true })
      disposal = pending
      pending.catch(() => {
        if (disposal === pending) disposal = undefined
      })
    }
    await disposal
  }

  try {
    await chmod(temporaryRoot, 0o700)
    await mkdir(filesystemRoot, { mode: 0o700 })
    const fields = launchFields(binding)
    const boundFiles = new Map()
    const providerRootPath = relative(resolve('/'), binding.rootPath)
    for (const identity of binding.launchIdentityFiles) {
      const stagedIdentityPath = providerRootPath === '' ? identity.path : `${providerRootPath}/${identity.path}`
      addBoundFile(boundFiles, stagedIdentityPath, {
        sourcePath: identity.sourcePath,
        digest: identity.digest,
        executable: false,
      })
    }

    const commandPath = relative(resolve('/'), fields.command)
    addBoundFile(boundFiles, commandPath, {
      sourcePath: fields.command,
      digest: binding.commandDigest,
      executable: true,
    })
    const materializedDirectories = new Set()
    for (const path of boundFiles.keys()) addDirectoryAndParents(materializedDirectories, dirname(path) === '.' ? '' : dirname(path))
    await mirrorSparseTree(resolve('/'), filesystemRoot, boundFiles, materializedDirectories)

    const command = resolve(filesystemRoot, commandPath)
    const stagedBySourcePath = new Map()
    const stagedDirectories = new Map()
    for (const [path, declaration] of boundFiles) {
      const stagedPath = resolve(filesystemRoot, path)
      stagedBySourcePath.set(declaration.sourcePath, stagedPath)
      const sourceDirectory = dirname(declaration.sourcePath)
      const stagedDirectory = dirname(stagedPath)
      const existing = stagedDirectories.get(sourceDirectory)
      if (existing !== undefined && existing !== stagedDirectory) {
        throw new HostError('HOST_PROVIDER_REPLACED', 'Provider launch identities map one source directory to conflicting staged directories', {
          retryable: true,
        })
      }
      stagedDirectories.set(sourceDirectory, stagedDirectory)
    }
    const args = stagedArguments(fields.args, binding.argumentReferences ?? [], stagedBySourcePath)
    const commandInfo = await lstat(command)
    if (!commandInfo.isFile() || commandInfo.nlink !== 1 || (commandInfo.mode & 0o111) === 0) {
      throw new HostError('HOST_PROVIDER_REPLACED', 'Frozen provider command is not one private executable file', {
        retryable: true,
      })
    }
    return Object.freeze({
      command,
      args: Object.freeze(args),
      cwd: fields.cwd,
      rootPath: temporaryRoot,
      prepareEnvironment: (environment) => prepareEnvironment(environment, fields.cwd, stagedDirectories),
      dispose,
    })
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new HostError('HOST_CLEANUP_FAILED', 'Failed provider launch snapshot was not removed', {
        cause: cleanupError,
      })
    }
    if (error instanceof HostError) throw error
    throw new HostError('HOST_PROVIDER_REPLACED', 'Provider execution identity could not be frozen before launch', {
      cause: error,
      retryable: true,
    })
  }
}
