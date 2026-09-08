/**
 * Object > Layers commands.
 */
import { registerCommands, when } from '@/commands/registry';
import { getState, type EditorState } from '@/store/store';
import { selectedLayerIds } from '@/ui/panels/layers/layersStore';
import { newLayer, newSublayer, duplicateLayers, deleteLayers, mergeLayers, collectInNewLayer, releaseToLayers, flattenArtwork, lockOthers, hideOthers } from './ops';

const hasObjects = (s: EditorState) => s.selection.some((id) => s.doc.nodes[id] && s.doc.nodes[id].type !== 'layer');
const canMerge = () => selectedLayerIds().length >= 2;
const canDeleteLayer = (s: EditorState) => s.doc.layers.length > 1 && selectedLayerIds().length > 0;
const canRelease = (s: EditorState) => {
  const g = s.selection.find((x) => s.doc.nodes[x]?.type === 'group');
  const id = g ?? s.activeLayerId;
  const n = id ? s.doc.nodes[id] : undefined;
  return !!n && (n.type === 'group' || n.type === 'layer') && n.children.length > 0;
};

registerCommands([
  { id: 'layer.new', label: 'New Layer', menu: 'Object/Layers', shortcut: 'mod+l', order: 200, run: () => { newLayer(); } },
  { id: 'layer.newSublayer', label: 'New Sublayer', menu: 'Object/Layers', shortcut: 'mod+alt+l', order: 201, run: () => { newSublayer(); } },
  { id: 'layer.duplicate', label: 'Duplicate Layer', menu: 'Object/Layers', order: 202, run: () => { duplicateLayers(selectedLayerIds()); }, enabled: () => selectedLayerIds().length > 0 },
  { id: 'layer.delete', label: 'Delete Layer', menu: 'Object/Layers', order: 203, run: () => deleteLayers(selectedLayerIds()), enabled: canDeleteLayer },
  { id: 'layer.options', label: 'Layer Options…', menu: 'Object/Layers', order: 204, run: () => { const id = selectedLayerIds()[0]; if (id) getState().openDialog('layerOptions', { id }); }, enabled: () => selectedLayerIds().length > 0 },
  { id: 'layer.mergeSelected', label: 'Merge Selected Layers', menu: 'Object/Layers', order: 210, separatorBefore: true, run: () => { mergeLayers(selectedLayerIds()); }, enabled: canMerge },
  { id: 'layer.collectInNewLayer', label: 'Collect in New Layer', menu: 'Object/Layers', order: 211, run: () => { collectInNewLayer(); }, enabled: hasObjects },
  { id: 'layer.releaseToLayers', label: 'Release to Layers (Sequence)', menu: 'Object/Layers', order: 212, run: () => { releaseToLayers(); }, enabled: canRelease },
  { id: 'layer.flatten', label: 'Flatten Artwork', menu: 'Object/Layers', order: 213, run: () => flattenArtwork(), enabled: (s) => s.doc.layers.length > 1 },
  { id: 'layer.lockOthers', label: 'Lock Others', menu: 'Object/Layers', order: 220, separatorBefore: true, run: () => { const s = getState(); lockOthers(s.selection.length ? s.selection : selectedLayerIds()); }, enabled: (s) => when.hasSelection(s) || selectedLayerIds().length > 0 },
  { id: 'layer.hideOthers', label: 'Hide Others', menu: 'Object/Layers', order: 221, run: () => { const s = getState(); hideOthers(s.selection.length ? s.selection : selectedLayerIds()); }, enabled: (s) => when.hasSelection(s) || selectedLayerIds().length > 0 },
]);
