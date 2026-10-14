import { atom, read, update } from 'claude-code'
import type { Hook, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import { toSpeech } from './speech'

type Dollar = Parameters<Hook<'session.start'>>[0]

const answer = atom({ plugin: 'read-aloud', key: 'answer' } as const, null)
const isSpeaking = atom({ plugin: 'read-aloud', key: 'isSpeaking' } as const, false)

let speech: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null

async function stop($: Dollar) {
  const current = speech
  speech = null
  await current?.return(undefined as never)
  await update($, isSpeaking, () => false)
}

async function speak($: Dollar, text: string, voice: string, rate: string) {
  await stop($)
  const current = $.process.spawn({ argv: ['say', '-v', voice, '-r', rate], input: text })
  speech = current
  await update($, isSpeaking, () => true)

  void (async () => {
    try {
      for await (const chunk of current) {
        if (chunk.stream === 'stderr') $.ui.log(chunk.text, { to: 'debug' })
      }
      const { code } = await current.result
      if (code !== 0 && code !== null) $.ui.toast(`朗读失败：say 退出码 ${code}`)
    } catch (err) {
      if (speech === current) $.ui.toast(`朗读失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (speech === current) {
        speech = null
        await update($, isSpeaking, () => false)
      }
    }
  })()
}

export const register: Register = (on, options) => {
  const voice = String(options.voice ?? 'Tingting')
  const rate = String(options.rate ?? 220)

  on('session.start', async ($, e, next) => {
    await update($, isSpeaking, () => false)
    // 在 /config 换了声音后模块会重载：用新声音试听一句
    const heard = await $.store.get('voice')
    if (heard !== voice) {
      await $.store.set('voice', voice)
      if (heard !== undefined) await speak($, `你好，我是${voice}`, voice, rate)
    }
    await $.command.register({
      name: 'read',
      description: '朗读上一条回答；朗读中再次执行则停止',
    })

    return next(e)
  })

  on('command.run', { command: 'read' }, async $ => {
    if (await read($, isSpeaking)) {
      await stop($)
      return { text: '已停止朗读。' }
    }
    const last = await read($, answer)
    if (last === null) return { text: '还没有可朗读的回答。' }
    await speak($, last.text, voice, rate)

    return { text: `开始朗读（约 ${last.chars} 字）。` }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      const text = toSpeech(e.answer)
      if (text !== '') await update($, answer, () => ({ text, chars: text.length }))
    }

    return done
  })
}
