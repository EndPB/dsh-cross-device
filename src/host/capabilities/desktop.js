/** Desktop capability pack: system, GPU, filesystem, and optional shell. */
import { execFile, exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { platform, arch, cpus, totalmem, freemem, hostname } from 'node:os'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

function cap(name, description, parameters, handler, { danger = false, enabled = true } = {}) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters, additionalProperties: false },
    output: { type: 'object', properties: { text: { type: 'string' } } },
    danger,
    enabled,
    async handler(args = {}, context) {
      const value = await handler(args, context)
      return typeof value === 'string' ? { text: value, content: [{ type: 'text', text: value }] } : value
    },
  }
}

async function gpuInfo() {
  const lines = []
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader'], { timeout: 10_000, windowsHide: true })
    for (const line of String(stdout).trim().split(/\r?\n/u).filter(Boolean)) lines.push(`NVIDIA: ${line}`)
  } catch {}
  if (lines.length === 0 && platform() === 'win32') {
    try {
      const { stdout } = await execAsync('wmic path win32_VideoController get Name,AdapterRAM,DriverVersion /format:list', { timeout: 10_000, windowsHide: true })
      for (const line of String(stdout).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) lines.push(line)
    } catch {}
  }
  if (lines.length === 0 && platform() === 'linux') {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', 'lspci | grep -Ei "vga|3d|display"'], { timeout: 10_000 })
      for (const line of String(stdout).trim().split(/\r?\n/u).filter(Boolean)) lines.push(line)
    } catch {}
  }
  return lines.length > 0 ? lines.join('\n') : 'No GPU information available on this node.'
}

export async function desktopCapabilities(settings = {}) {
  const allowShell = settings.capabilities?.shell === true
  const allowWrite = settings.capabilities?.fsWrite === true
  return [
    cap('system.info', 'Read this desktop node system information: OS, CPU, memory, hostname.', {}, async () => {
      return JSON.stringify({
        hostname: hostname(), platform: platform(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model,
        totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), node: process.version,
      }, null, 2)
    }),
    cap('gpu.info', 'Read GPU status on this desktop node (NVIDIA/Windows/Linux).', {}, async () => gpuInfo()),
    cap('fs.read', 'Read a UTF-8 text file on this node. Limit 256 KiB.', {
      path: { type: 'string' }, maxBytes: { type: 'number' },
    }, async (args) => {
      const path = resolve(String(args.path ?? ''))
      const max = Math.min(Number(args.maxBytes ?? 256 * 1024), 1024 * 1024)
      const info = await stat(path)
      if (!info.isFile()) throw new Error('path is not a file')
      const buffer = await readFile(path)
      return buffer.subarray(0, max).toString('utf8')
    }),
    cap('fs.list', 'List a directory on this node.', {
      path: { type: 'string' }, limit: { type: 'number' },
    }, async (args) => {
      const path = resolve(String(args.path ?? '.'))
      const entries = await readdir(path, { withFileTypes: true })
      const limit = Math.min(Number(args.limit ?? 200), 1000)
      return entries.slice(0, limit).map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`).join('\n')
    }),
    cap('fs.write', 'Write a UTF-8 text file on this node. Disabled unless explicitly enabled.', {
      path: { type: 'string' }, text: { type: 'string' },
    }, async (args) => {
      const path = resolve(String(args.path ?? ''))
      await writeFile(path, String(args.text ?? ''), 'utf8')
      return `wrote ${Buffer.byteLength(String(args.text ?? ''), 'utf8')} bytes to ${path}`
    }, { danger: true, enabled: allowWrite }),
    cap('shell.run', 'Run a shell command on this node. Disabled by default; enable only for trusted devices.', {
      command: { type: 'string' }, timeoutMs: { type: 'number' },
    }, async (args) => {
      const timeout = Math.min(Math.max(Number(args.timeoutMs ?? 30_000), 1000), 120_000)
      const { stdout, stderr } = await execAsync(String(args.command ?? ''), { timeout, windowsHide: true, maxBuffer: 1024 * 1024 })
      return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
    }, { danger: true, enabled: allowShell }),
  ]
}