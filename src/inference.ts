export interface InferenceDevice { id: string; provider: 'cpu' | 'directml'; device: number; label: string }
export interface InferenceChoice { provider: 'cpu' | 'directml'; device: number }
export function inferenceChoice(id: string): InferenceChoice {
  const match = /^directml:(\d+)$/.exec(id);
  return match && Number(match[1]) <= 128 ? { provider: 'directml', device: Number(match[1]) } : { provider: 'cpu', device: 0 };
}
