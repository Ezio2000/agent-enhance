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

/** One capability as `cc-enhance cli json` reports it. */
export type CapabilityRow = {
  capability: string
  label: string
  /** Connection a call uses when it omits provider/service. */
  service?: string
  via?: 'service' | 'preferred' | 'default' | 'sole'
  alternatives: number
  state: 'ready' | 'off' | 'problem'
  /** Why it is not ready, and the next step. */
  note?: string
  /** Connections implementing it, in automatic-selection order. */
  services: string[]
  preferred?: string
  /** The whole capability is excluded. */
  excluded: boolean
  excludedServices: string[]
}

export type Overview = {
  capabilities: CapabilityRow[]
  connections: number
  errors: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'enhance-companion': {
      artifacts: Artifact[]
      /** Last overview read for the /enhance pane; null until read. */
      overview: Overview | null
      /** Capability whose choices the pane shows, or ''. */
      expanded: string
      /** Output of the pane's last action. */
      message: string
    }
  }
}
