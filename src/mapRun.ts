import { compileBundle, type BtData, type BtNode } from './behaviorModel';
import type { MapDoc, MapLink } from './mapModel';

// Run the map through the existing behavior executor without creating another
// saved graph. A clip test is deliberately just that clip, without navigation.
export function mapRun(doc: MapDoc, mapId: string, read: (id: string) => string | null,
  request: { destination: string } | { clip: MapLink }) {
  const data: BtData = 'clip' in request
    ? { kind: 'clip', ...request.clip.clip }
    : { kind: 'go', map: mapId, place: request.destination, target: '' };
  if ('clip' in request && (request.clip.kind !== 'clip' || !request.clip.clip)) throw new Error('Choose a recording clip for this link first');
  const nodes: BtNode[] = [
    { id: 'root', type: 'bt', position: { x: 0, y: 0 }, data: { kind: 'root', loop: false } },
    { id: 'action', type: 'bt', position: { x: 0, y: 150 }, data },
  ];
  return compileBundle({ nodes, edges: [{ id: 'run', source: 'root', sourceHandle: 'children', target: 'action', targetHandle: 'parent' }] },
    id => id === mapId ? JSON.stringify(doc) : read(id));
}
