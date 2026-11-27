export type BackgroundTask = { id: string; runId?: string }
export type BackgroundState = {
  tasks: BackgroundTask[]
  lineage: string[]
  shed?: { resetAt?: number; crossedAt?: number; eligible: string[] }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-crossfeed': { background: StateFamily<BackgroundState> }
  }
}
