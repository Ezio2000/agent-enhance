export type Artifact = {
  /** Absolute path of the generated file. */
  path: string
  /** Capability that produced it, e.g. `gen_image`. */
  tool: string
  /** Provider short name, e.g. `xai`. */
  provider: string
  /** File name inside the call directory. */
  file: string
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number
  /** Size in bytes. */
  size: number
}

declare module 'claude-code' {
  interface PluginState {
    'enhance-companion': { artifacts: Artifact[] }
  }
}
