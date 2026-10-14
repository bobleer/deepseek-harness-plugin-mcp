import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, resolve, extname } from 'node:path'
import type { ChildHandle, DshCommandResult, DshRunner } from '../types.js'

export function which(command: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (!pathEnv) return null
  const ext = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    for (const suffix of ext) {
      const candidate = `${dir}/${command}${suffix}`
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Resolve the packaged Windows desktop CLI without a command shell. */
export function resolveDshLaunch(dsh: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32' || extname(dsh).toLowerCase() !== '.cmd') {
    return { command: dsh, prefix: [] as string[], env }
  }
  const executable = resolve(dirname(dsh), '../../../../DeepSeek Harness.exe')
  const archive = resolve(dirname(dsh), '../../../app.asar')
  if (!existsSync(executable) || !existsSync(archive)) {
    throw new Error('Unsupported dsh.cmd layout: native desktop CLI entry not found')
  }
  const entry = resolve(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  return {
    command: executable,
    prefix: ['--expose-internals', entry],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  }
}

export class ProcessDshRunner implements DshRunner {
  constructor(
    private readonly pathEnv: string | undefined = process.env.PATH,
    private readonly extraEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  whichDsh(): string | null {
    return which('dsh', this.pathEnv)
  }

  async runPlugin(profile: string, args: readonly string[]): Promise<DshCommandResult> {
    const dsh = this.whichDsh()
    if (!dsh) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: 'dsh not found on PATH — install DeepSeek Harness and retry',
      }
    }
    const launch = resolveDshLaunch(dsh, this.extraEnv)
    const result = spawnSync(launch.command, [...launch.prefix, 'plugin', '--profile', profile, ...args], {
      encoding: 'utf8',
      env: launch.env,
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { exitCode: 127, stdout: '', stderr: 'dsh not found on PATH — install DeepSeek Harness and retry' }
      }
      throw result.error
    }
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }

  spawnProfile(options: { profile: string; env: Record<string, string>; cwd?: string }): ChildHandle {
    const dsh = this.whichDsh()
    if (!dsh) {
      throw new Error('dsh not found on PATH — install DeepSeek Harness before starting the runtime')
    }
    const launch = resolveDshLaunch(dsh, { ...this.extraEnv, ...options.env })
    const child = spawn(launch.command, [...launch.prefix, '--profile', options.profile], {
      env: launch.env,
      windowsHide: true,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      pid: child.pid,
      kill(signal?: NodeJS.Signals) {
        child.kill(signal)
      },
      onExit(handler) {
        if (child.exitCode !== null || child.signalCode !== null) {
          handler(child.exitCode, child.signalCode)
          return
        }
        child.on('exit', handler)
      },
      stdout: child.stdout,
      stderr: child.stderr,
    }
  }
}

export function pluginAddArgs(spec: string): string[] {
  return ['add', spec]
}

export function pluginRemoveArgs(packageName: string): string[] {
  return ['remove', packageName]
}

export function formatDshFailure(result: DshCommandResult): string {
  const parts = [
    `dsh plugin exited ${result.exitCode}`,
    result.stderr.trim() || result.stdout.trim() || '(no output)',
  ]
  return parts.join('\n')
}
