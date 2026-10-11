import { expect, test } from 'claude-code/testing'

import { describeRow, formatSize, formatTime, installPaths, splitArgs } from './lib'

test('formatSize picks a unit', () => {
  expect(formatSize(512)).toEqual('512 B')
  expect(formatSize(2048)).toEqual('2 KB')
  expect(formatSize(3.5 * 1024 * 1024)).toEqual('3.5 MB')
})

test('formatTime pads month, day, hour and minute', () => {
  const d = new Date(2026, 9, 5, 8, 7)
  expect(formatTime(d.getTime())).toEqual('10-05 08:07')
})

test('splitArgs drops blank arguments', () => {
  expect(splitArgs('  prefer  gen_image pi:xai ')).toEqual(['prefer', 'gen_image', 'pi:xai'])
  expect(splitArgs('')).toEqual([])
})

test('installPaths reads cc-enhance entries and tolerates bad input', () => {
  const registry = JSON.stringify({
    plugins: {
      'cc-enhance@agent-enhance': [{ installPath: '/a' }, { scope: 'project' }],
      'other@x': [{ installPath: '/b' }],
    },
  })
  expect(installPaths(registry)).toEqual(['/a'])
  expect(installPaths('not json')).toEqual([])
})

test('describeRow shows the routed connection or the reason', () => {
  expect(
    describeRow({ state: 'ready', service: 'pi:xai', via: 'preferred', alternatives: 2 }),
  ).toEqual('pi:xai · preferred · +2')
  expect(describeRow({ state: 'ready', service: 'local:x', via: 'sole', alternatives: 0 })).toEqual(
    'local:x',
  )
  expect(describeRow({ state: 'off', alternatives: 0, note: 'excluded' })).toEqual('excluded')
})
