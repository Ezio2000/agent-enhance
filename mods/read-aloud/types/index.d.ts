export type Answer = { text: string; chars: number }

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': { answer: Answer | null; isSpeaking: boolean }
  }
}
