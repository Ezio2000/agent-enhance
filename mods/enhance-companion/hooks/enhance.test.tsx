import { expect, mock, test } from 'claude-code/testing'

const CLI = '/plugins/cc-enhance/dist/cc-enhance.mjs'
const OVERVIEW = {
  capabilities: [
    {
      capability: 'gen_image',
      label: '图片生成',
      service: 'pi:xai',
      via: 'default',
      alternatives: 1,
      state: 'ready',
      services: ['pi:xai', 'codex:openai-codex'],
      excluded: false,
      excludedServices: [],
    },
    {
      capability: 'use_computer',
      label: '桌面操作',
      service: 'local:chatgpt-desktop',
      via: 'sole',
      alternatives: 0,
      state: 'ready',
      services: ['local:chatgpt-desktop'],
      excluded: false,
      excludedServices: [],
    },
    {
      capability: 'gen_voice',
      label: '语音合成',
      alternatives: 0,
      state: 'problem',
      note: 'no connection · set MINIMAX_API_KEY',
      services: [],
      excluded: false,
      excludedServices: [],
    },
  ],
  connections: 3,
  errors: {},
}

test('/enhance runs the CLI directly and its pane changes connections', async ($, on) => {
  const runs: string[][] = []
  mock.env(on, { HOME: '/home' })
  on('fs.read', async () => ({
    value: JSON.stringify({ plugins: { 'cc-enhance@agent-enhance': [{ installPath: '/plugins/cc-enhance' }] } }),
  }))
  on('fs.exists', async ($, e) => ({ value: e.path === CLI }))
  on('process.run', async ($, e) => {
    const args = e.argv.slice(3)
    runs.push([...e.argv])
    const stdout = args[0] === 'json' ? JSON.stringify(OVERVIEW) : `ran ${args.join(' ')}`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))

  const enhance = (args: string) =>
    $.command.run({
      command: 'enhance',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
  const status = await enhance(' status ')
  expect(status.text).toEqual('ran status')
  expect(runs[0]).toEqual(['node', CLI, 'cli', 'status'])

  await enhance('')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'enhance-companion',
      surface,
      component: 'Pane',
      requestId: 'enhance',
      props: {
        title: 'Agent Enhance',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ key: 'row:gen_image' })).toBeDefined()
    expect(await ui.find({ key: 'computer:status' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no connection/ })).toBeDefined()
    await ui.press({ key: 'row:gen_image' })
    await ui.press({ key: 'prefer:gen_image:codex:openai-codex' })
    expect(runs.some(argv => argv.slice(3).join(' ') === 'prefer gen_image codex:openai-codex')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /ran prefer gen_image codex:openai-codex/ })).toBeDefined()
    await ui.press({ key: 'row:gen_image' })
    await ui.unmount()
  }
})
