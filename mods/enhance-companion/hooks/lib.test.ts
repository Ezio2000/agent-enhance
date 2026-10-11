import { expect, test } from 'claude-code/testing'

import { formatSize, formatTime } from './lib'

test('formatSize picks a unit', () => {
  expect(formatSize(512)).toEqual('512 B')
  expect(formatSize(2048)).toEqual('2 KB')
  expect(formatSize(3.5 * 1024 * 1024)).toEqual('3.5 MB')
})

test('formatTime pads month, day, hour and minute', () => {
  const d = new Date(2026, 9, 5, 8, 7)
  expect(formatTime(d.getTime())).toEqual('10-05 08:07')
})
