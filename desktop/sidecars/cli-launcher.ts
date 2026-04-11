/**
 * Claude Code 桌面端 CLI sidecar 入口。
 *
 * 与 server-launcher.ts 同理：通过字面量 specifier 的 dynamic import
 * 让 `bun build --compile` 把整棵 src/entrypoints/cli.tsx 依赖图静态
 * 内联进二进制。运行时不再依赖磁盘上的 src/ 或 node_modules/。
 */

const { appRoot, args } = parseLauncherArgs()

process.env.CLAUDE_APP_ROOT = appRoot
process.env.CALLER_DIR ||= process.cwd()
process.argv = [process.argv[0]!, process.argv[1]!, ...args]

await import('../../preload.ts')
await import('../../src/entrypoints/cli.tsx')

function parseLauncherArgs() {
  const rawArgs = process.argv.slice(2)
  const nextArgs: string[] = []
  let appRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--app-root') {
      appRoot = rawArgs[index + 1] ?? null
      index += 1
      continue
    }
    nextArgs.push(arg)
  }

  if (!appRoot) {
    throw new Error('Missing --app-root for claude-cli sidecar')
  }

  return { appRoot, args: nextArgs }
}
