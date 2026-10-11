import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Overview } from '../types'
import { describeRow, formatSize, formatTime, installPaths, splitArgs } from './lib'

const ARTIFACT_PANE = 'enhance-artifacts'
const ARTIFACT_LIMIT = 100

const artifacts = atom({ plugin: 'enhance-companion', key: 'artifacts' } as const, [] as Artifact[])

/**
 * Scans ~/.agent-enhance/artifacts/claude-code/<tool>/<provider>/<session>/<call>/<file>,
 * newest first. There is no index file; the directory tree is the record.
 */
async function scanArtifacts($: EngineInterface): Promise<Artifact[]> {
  const home = await $.env.get('HOME')
  if (!home) return []
  const root = `${home}/.agent-enhance/artifacts/claude-code`
  if (!(await $.fs.exists(root))) return []
  const found: Artifact[] = []
  const dirs = (path: string) => $.fs.list(path).catch(() => [])
  for (const tool of await dirs(root)) {
    if (tool.kind !== 'dir') continue
    for (const provider of await dirs(`${root}/${tool.name}`)) {
      if (provider.kind !== 'dir') continue
      for (const session of await dirs(`${root}/${tool.name}/${provider.name}`)) {
        if (session.kind !== 'dir') continue
        const callRoot = `${root}/${tool.name}/${provider.name}/${session.name}`
        for (const call of await dirs(callRoot)) {
          if (call.kind !== 'dir') continue
          for (const file of await dirs(`${callRoot}/${call.name}`)) {
            if (file.kind !== 'file') continue
            found.push({
              path: `${callRoot}/${call.name}/${file.name}`,
              tool: tool.name,
              provider: provider.name,
              file: file.name,
              mtimeMs: file.mtimeMs,
              size: file.size,
            })
          }
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, ARTIFACT_LIMIT)
}

/** Opens a file in its default app: `open` on macOS, `xdg-open` elsewhere. */
async function openFile($: EngineInterface, path: string): Promise<string | undefined> {
  let reason = 'no opener found'
  for (const opener of ['open', 'xdg-open']) {
    try {
      const { exitCode, stderr } = await $.process.run([opener, path])
      if (exitCode === 0) return
      reason = stderr.trim() || `${opener} exited ${exitCode}`
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  return reason
}

const MANAGE_PANE = 'enhance'
const COMPUTER_ACTIONS = ['status', 'ask', 'auto', 'revoke', 'reset']

const overview = atom({ plugin: 'enhance-companion', key: 'overview' } as const, null as Overview | null)
const expanded = atom({ plugin: 'enhance-companion', key: 'expanded' } as const, '')
const message = atom({ plugin: 'enhance-companion', key: 'message' } as const, '')

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** dist/cc-enhance.mjs of the installed plugin, else of the repository this mod sits in. */
async function cliPath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const registry = await $.fs.read(`${config}/plugins/installed_plugins.json`).catch(() => '')
  const candidates = [
    ...installPaths(registry).map(root => `${root}/dist/cc-enhance.mjs`),
    `${$.plugin.root}/../../dist/cc-enhance.mjs`,
  ]
  for (const path of candidates) if (await $.fs.exists(path)) return path
  throw new Error('cc-enhance is not installed: claude plugin install cc-enhance@agent-enhance')
}

/** Runs the cc-enhance CLI from this Claude Code process, so it reaches this session's server. */
async function cli($: EngineInterface, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ['node', await cliPath($), 'cli', ...args],
    // computer reset waits up to a minute for the desktop runtime to stop.
    { timeoutMs: 90_000 },
  )
  return stdout.trim() || stderr.trim() || `cc-enhance exited ${exitCode}`
}

async function reload($: EngineInterface): Promise<void> {
  try {
    const text = await cli($, ['json'])
    await update($, overview, () => JSON.parse(text) as Overview)
  } catch (error) {
    await update($, message, () => `Could not read cc-enhance: ${reason(error)}`)
  }
}

async function act($: EngineInterface, args: string[]): Promise<void> {
  await update($, message, () => `Running /enhance ${args.join(' ')}…`)
  let text: string
  try {
    text = await cli($, args)
  } catch (error) {
    text = `Error: ${reason(error)}`
  }
  await update($, message, () => text)
  await reload($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'enhance',
      description: 'Agent Enhance: capabilities, connections, preferences and the computer bridge',
      argumentHint:
        '[status | services | refresh | prefer <capability> [service|auto] | exclude|include <capability> [service] | computer <action> | help]',
    })
    await $.command.register({
      name: 'enhance-artifacts',
      description: 'Browse files generated by cc-enhance in a pane',
    })
    return next(e)
  })

  on('command.run', { command: 'enhance-artifacts' }, async $ => {
    const found = await scanArtifacts($)
    await update($, artifacts, () => found)
    // focus hands the pane the keyboard so Escape closes it at once.
    const opened = await $.ui.open({
      id: ARTIFACT_PANE,
      title: 'Enhance artifacts',
      focus: true,
      closeOnEscape: true,
    })
    if (!opened.isPlaced) {
      return { text: `Artifact pane could not open: ${opened.reason}` }
    }
    return {
      text:
        found.length === 0
          ? 'No cc-enhance artifacts yet.'
          : `${found.length} artifacts, newest first.`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: ARTIFACT_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, artifacts)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)

    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="refresh"
            label="Refresh"
            onPress={async () => {
              const found = await scanArtifacts($)
              await update($, artifacts, () => found)
            }}
          />
          <Text> </Text>
          <Button
            key="close"
            role="dismiss"
            label="Close"
            onPress={() => $.ui.close({ id: ARTIFACT_PANE })}
          />
        </Box>
        {list.length === 0 && (
          <Text dimColor>No artifacts under ~/.agent-enhance/artifacts yet.</Text>
        )}
        {list.slice(0, room).map((a, i) => (
          <Box key={a.path}>
            <Text dimColor>{formatTime(a.mtimeMs)}  </Text>
            <Text>
              {a.tool}/{a.provider}{' '}
            </Text>
            <Button
              key={`open:${i}`}
              plain
              label={a.file}
              onPress={async () => {
                const failed = await openFile($, a.path)
                $.ui.toast(failed ? `open failed: ${failed}` : `opened: ${a.file}`)
              }}
            />
            <Text> ({formatSize(a.size)}) </Text>
            <Button
              key={`copy:${i}`}
              plain
              label="copy"
              onPress={async () => {
                const copied = await $.ui.copy({ text: a.path })
                $.ui.toast(copied.isCopied ? `copied: ${a.file}` : `copy failed: ${copied.reason}`)
              }}
            />
          </Box>
        ))}
        {list.length > room && <Text dimColor>… {list.length - room} more</Text>}
      </Box>
    )
  })

  on('command.run', { command: 'enhance' }, async ($, e) => {
    const args = splitArgs(e.args)
    if (args.length) {
      try {
        return { text: await cli($, args) }
      } catch (error) {
        return { text: `Error: ${reason(error)}` }
      }
    }
    await update($, expanded, () => '')
    await update($, message, () => '')
    await reload($)
    const opened = await $.ui.open({
      id: MANAGE_PANE,
      title: 'Agent Enhance',
      focus: true,
      closeOnEscape: true,
    })
    if (!opened.isPlaced) {
      const status = await cli($, ['status']).catch(reason)
      return { text: `${status}\n\n(The pane could not open: ${opened.reason})` }
    }
    return { text: 'Agent Enhance pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: MANAGE_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const data = await read($, overview)
    const open = await read($, expanded)
    const note = await read($, message)
    const rows = data?.capabilities ?? []
    const width = Math.max(0, ...rows.map(row => row.capability.length))
    const computer = rows.find(row => row.capability === 'use_computer')?.state === 'ready'
    const color = { ready: 'success', off: 'inactive', problem: 'error' } as const
    const mark = { ready: '✓', off: '–', problem: '✗' } as const

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => act($, ['refresh'])} />
          <Text> </Text>
          <Button key="close" role="dismiss" label="Close" onPress={() => $.ui.close({ id: MANAGE_PANE })} />
        </Box>
        {!data && <Text dimColor>Reading cc-enhance…</Text>}
        {data && <Text dimColor>Select a capability to change its connection or exclude it.</Text>}
        {rows.map(row => {
          const isOpen = open === row.capability
          return (
            <Box key={`cap:${row.capability}`} flexDirection="column">
              <Button
                key={`row:${row.capability}`}
                plain
                onPress={() => update($, expanded, current => (current === row.capability ? '' : row.capability))}
              >
                {isOpen ? '▾ ' : '▸ '}
                <Text color={color[row.state]}>{mark[row.state]}</Text> {row.capability.padEnd(width)}{'  '}
                <Text dimColor={row.state !== 'ready'}>{describeRow(row)}</Text>
              </Button>
              {isOpen && !row.excluded &&
                row.services.map(id => (
                  <Button
                    key={`prefer:${row.capability}:${id}`}
                    plain
                    onPress={() => act($, ['prefer', row.capability, id])}
                  >
                    {'    '}
                    {id === row.service ? '● ' : '○ '}
                    {id}
                    {row.excludedServices.includes(id) && <Text dimColor> (excluded)</Text>}
                  </Button>
                ))}
              {isOpen && !row.excluded && row.services.length > 0 && (
                <Button
                  key={`prefer:${row.capability}:auto`}
                  plain
                  onPress={() => act($, ['prefer', row.capability, 'auto'])}
                >
                  {'    '}
                  {row.preferred ? '○ ' : '● '}auto <Text dimColor>(built-in order)</Text>
                </Button>
              )}
              {isOpen && (
                <Box>
                  <Text>{'    '}</Text>
                  <Button
                    key={`toggle:${row.capability}`}
                    label={row.excluded ? `Include ${row.capability}` : `Exclude ${row.capability}`}
                    onPress={() => act($, [row.excluded ? 'include' : 'exclude', row.capability])}
                  />
                </Box>
              )}
            </Box>
          )
        })}
        {computer && (
          <Box flexWrap="wrap">
            <Text>Computer: </Text>
            {COMPUTER_ACTIONS.map(action => (
              <Box key={`computer-box:${action}`}>
                <Button
                  key={`computer:${action}`}
                  label={action}
                  onPress={() => act($, ['computer', action])}
                />
                <Text> </Text>
              </Box>
            ))}
          </Box>
        )}
        {data && Object.keys(data.errors).length > 0 && (
          <Text color="warning">
            Discovery errors: {Object.entries(data.errors).map(([source, error]) => `${source}: ${error}`).join('; ')}
          </Text>
        )}
        {note !== '' && <Text dimColor>{note}</Text>}
      </Box>
    )
  })
}
