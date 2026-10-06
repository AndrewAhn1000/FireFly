import type { ScriptGeometry } from './scriptRegions';

export interface LuaReading extends ScriptGeometry {
  value: unknown;
  timestamp?: number;
  regionsRead?: string[];
}

interface ReadableState {
  id: string; name: string; source: string; off?: boolean;
  address?: string; offsets?: string[]; byteType?: string;
  script?: string; scriptWidth?: number; scriptHeight?: number;
}
// The States a Lua script can read as states.Name: the ones the runtime can read itself, from memory or by a script.
// One turned off is sent as off, so a script reading it fails saying so, without reading or running it.
export function luaStateDefinitions(states: ReadableState[]): ({ id: string; name: string; kind: string } & Record<string, unknown>)[] {
  return states.flatMap((s): ({ id: string; name: string; kind: string } & Record<string, unknown>)[] => {
    const off = s.off ? { off: true } : {};
    return s.source === 'memory' && s.address ? [{ id: s.id, name: s.name, kind: 'memory', address: s.address, offsets: s.offsets ?? [], byteType: s.byteType ?? 'u32', ...off }]
      : s.source === 'script' && s.script ? [{ id: s.id, name: s.name, kind: 'script', script: s.script, scriptWidth: s.scriptWidth ?? 0, scriptHeight: s.scriptHeight ?? 0, ...off }]
      : [];
  });
}

// One runner per refresh, never a cache across refreshes or capture targets. Share
// the raw result before Region scaling, including failures and explicit empty lists.
export function luaPollRunner(
  invoke: (op: string, args: Record<string, unknown>) => Promise<unknown>,
  regions: unknown,
  states: unknown = [],
) {
  const pending = new Map<string, Promise<LuaReading>>();
  return async (script: string, width = 0, height = 0, regionId?: string): Promise<LuaReading> => {
    const args = { script, scriptWidth: width, scriptHeight: height, regions, states };
    const key = JSON.stringify([script, width, height]);
    let reading = pending.get(key);
    if (!reading) {
      reading = invoke('memory.run_script', args) as Promise<LuaReading>;
      pending.set(key, reading);
    }
    const result = await reading;
    if (regionId) {
      // An older runtime cannot report dependencies: retain its native self-reference
      // check through a separate Region evaluation until that runtime is restarted.
      if (!Array.isArray(result.regionsRead))
        return await invoke('memory.run_script', { ...args, regionId }) as LuaReading;
      if (result.regionsRead.includes(regionId)) throw Error('A Lua Region cannot read its own output');
    }
    return result;
  };
}
