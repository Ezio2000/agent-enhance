import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessSpawnRequest } from 'claude-code'

import { toSpeech } from './speech'

const READ = {
  command: 'read',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const TURN = { durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('markdown 转成可朗读文本', () => {
  const text = toSpeech(
    '## 结论\n\n- **可以**做到，见 [文档](https://x.dev)\n\n```ts\nconst a = 1\n```\n\n| 项 | 值 |\n|---|---|\n| 声音 | 婷婷 |',
  )
  expect(text).toBe('结论\n\n可以做到，见 文档\n\n（代码略）\n\n项，值\n声音，婷婷')
})

test('/read 用 say 读出上一条主回答，再次执行停止', async ($, on) => {
  const spawned: ProcessSpawnRequest[] = []
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('process.spawn', async function* ($, e, next) {
    spawned.push(e)
    for (;;) {
      await $.clock.sleep(10, { signal: next.signal })
      yield { stream: 'stdout' as const, text: '' }
    }
  })

  expect((await $.command.run(READ)).text).toBe('还没有可朗读的回答。')

  await $.turn.complete({ ...TURN, answer: '**完成**了，共 `3` 处改动。' })
  await $.turn.complete({ ...TURN, answer: '子代理报告', agentId: 'a1' })

  expect((await $.command.run(READ)).text).toContain('开始朗读')
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.argv).toEqual(['say', '-v', 'Tingting', '-r', '220'])
  expect(spawned[0]?.input).toBe('完成了，共 3 处改动。')
  expect((await $.command.run(READ)).text).toBe('已停止朗读。')
})

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

// 记下 say 调用；session.start、command.register 由引擎实现，测试里接住即可
const recordSpawns = (on: On) => {
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  const spawned: ProcessSpawnRequest[] = []
  on('process.spawn', async function* (_, e) {
    spawned.push(e)
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

test('首次加载和声音未变时启动不出声', async ($, on) => {
  const spawned = recordSpawns(on)
  mock.store(on)
  await $.session.start(START)
  await $.session.start(START)
  expect(spawned).toHaveLength(0)
})

test('换了声音后启动先用新声音试听一句', async ($, on) => {
  const spawned = recordSpawns(on)
  const clock = mock.clock(on)
  mock.store(on, { voice: 'Meijia' })
  await $.session.start(START)
  await clock.settle()
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.input).toBe('你好，我是Tingting')
  expect(spawned[0]?.argv).toEqual(['say', '-v', 'Tingting', '-r', '220'])
})
