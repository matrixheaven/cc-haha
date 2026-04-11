/**
 * Claude Code 桌面端 server sidecar 入口。
 *
 * 这里把 src/server 这棵树通过字面量 specifier 的 dynamic import 拉进来，
 * `bun build --compile` 会把它们作为静态依赖完整内联进单个二进制 ——
 * 编译后运行时不再需要磁盘上的 src/ 或 node_modules/。
 *
 * 注意：先做 process.env / process.argv 设置，再 await import，这样
 *   - src/server/index.ts 顶层读 process.argv 时拿到的是被剥过 --app-root 的值；
 *   - preload.ts 设置的 MACRO 全局在 server 模块求值前到位。
 */

const { appRoot, args } = parseLauncherArgs()

// 维持 conversationService → CLI 子进程的兼容契约：CLI sidecar 仍然
// 接受 --app-root 参数，所以 server 这边把它原样透传到环境变量里。
process.env.CLAUDE_APP_ROOT = appRoot
process.argv = [process.argv[0]!, process.argv[1]!, ...args]

await import('../../preload.ts')
const { startServer } = await import('../../src/server/index.ts')
startServer()

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
    throw new Error('Missing --app-root for claude-server sidecar')
  }

  return { appRoot, args: nextArgs }
}
