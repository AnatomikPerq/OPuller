/**
 * Sample documents: File > Open Sample.
 */
import type { Document } from '@/model/types';
import { registerCommands } from '@/commands/registry';
import { getState } from '@/store/store';
import { loadDocument, confirmDiscard } from '@/io/fileOps';
import { fitArtboard } from '@/commands/viewCommands';
import { twitterBirdSample } from './twitterBird';
import { showcaseSample } from './showcase';

export interface SampleDef {
  id: string;
  name: string;
  description: string;
  build: () => Document;
}

export const SAMPLES: SampleDef[] = [
  { id: 'bird', name: 'Bird from circles (Pathfinder)', description: 'The classic circle-construction bird: 13 circles combined with Unite, Minus Front and Intersect.', build: twitterBirdSample },
  { id: 'showcase', name: 'Showcase: shapes, gradients, effects, blend', description: 'Live shapes, gradient fills, dashed strokes with arrowheads, effects, a blend and area text.', build: showcaseSample },
];

export async function openSample(id: string, ask = true): Promise<boolean> {
  const def = SAMPLES.find((s) => s.id === id);
  if (!def) return false;
  if (ask && !(await confirmDiscard('open a sample'))) return false;
  try {
    const doc = def.build();
    loadDocument(doc, { fileName: null, dirty: false });
    getState().setSelection([]);
    fitArtboard();
    return true;
  } catch (err: any) {
    console.error(err);
    getState().toast(`Could not build the sample: ${err?.message ?? err}`, 'error');
    return false;
  }
}

registerCommands(
  SAMPLES.map((s, i) => ({
    id: `file.sample.${s.id}`,
    label: s.name,
    menu: 'File/Open Sample',
    order: 4 + i / 100,
    run: () => openSample(s.id),
  })),
);
