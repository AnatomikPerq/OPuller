/**
 * Properties panel: context sensitive — document settings when nothing is
 * selected, otherwise transform / appearance / shape / text / image sections
 * and quick actions for the selection.
 */
import React, { useMemo } from 'react';
import type { ID, LiveShape, NodeType } from '@/model/types';
import { useStore, getState } from '@/store/store';
import { Section, Divider } from '@/ui/widgets';
import { nodeTypeIcon } from '@/ui/panels/appearance/AppearancePanel';
import { DocumentSection } from './DocumentSection';
import { TransformSection } from './TransformSection';
import { AppearanceSection } from './AppearanceSection';
import { ShapeSection } from './ShapeSection';
import { TextSection } from './TextSection';
import { ImageSection } from './ImageSection';
import { QuickActions } from './QuickActions';
import { editTargets } from './edit';
import '@/ui/panels/appearance/appearance.css';
import './properties.css';

const SHAPE_TITLES: Record<LiveShape['kind'], string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  star: 'Star',
  line: 'Line',
  spiral: 'Spiral',
  arc: 'Arc',
};

const TYPE_NAMES: Record<NodeType, string> = { layer: 'Layer', group: 'Group', path: 'Path', text: 'Text', image: 'Image' };

interface SelectionInfo {
  targets: ID[];
  title: string;
  sub: string;
  shapeKind: LiveShape['kind'] | null;
  shapeIds: ID[];
  hasText: boolean;
  imageIds: ID[];
}

function analyse(selection: ID[]): SelectionInfo {
  const s = getState();
  const doc = s.doc;
  const targets = editTargets(s, selection);
  const nodes = selection.map((id) => doc.nodes[id]).filter(Boolean);
  const shapeIds = targets.filter((id) => doc.nodes[id]?.type === 'path' && !!(doc.nodes[id] as { shape?: LiveShape }).shape);
  const kinds = new Set(shapeIds.map((id) => (doc.nodes[id] as { shape?: LiveShape }).shape!.kind));
  const shapeKind = shapeIds.length === targets.length && kinds.size === 1 ? shapeIds.length ? (doc.nodes[shapeIds[0]] as { shape?: LiveShape }).shape!.kind : null : null;
  const hasText = targets.some((id) => doc.nodes[id]?.type === 'text' || doc.nodes[id]?.type === 'group');
  const textPresent = hasText && targets.some((id) => containsText(id));
  const imageIds = targets.filter((id) => doc.nodes[id]?.type === 'image');
  let title = 'No selection';
  let sub = '';
  if (nodes.length === 1) {
    const n = nodes[0];
    title = n.name;
    sub = n.type === 'path' && n.shape ? SHAPE_TITLES[n.shape.kind] : TYPE_NAMES[n.type];
    if (n.type === 'group' && n.clipId) sub = 'Clip group';
  } else if (nodes.length > 1) {
    title = `${nodes.length} objects`;
    const types = new Set(nodes.map((n) => n.type));
    sub = types.size === 1 ? `${TYPE_NAMES[nodes[0].type]}s` : 'Mixed';
  }
  return { targets, title, sub, shapeKind, shapeIds, hasText: textPresent, imageIds };
}

function containsText(id: ID): boolean {
  const doc = getState().doc;
  const n = doc.nodes[id];
  if (!n) return false;
  if (n.type === 'text') return true;
  if (n.type === 'group' || n.type === 'layer') return n.children.some(containsText);
  return false;
}

export function PropertiesPanel() {
  const selection = useStore((s) => s.selection);
  const docVersion = useStore((s) => s.docVersion);
  const info = useMemo(() => analyse(selection), [selection, docVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = selection.length === 1 ? getState().doc.nodes[selection[0]] : undefined;

  if (!selection.length) {
    return (
      <div className="properties-panel" data-testid="properties-panel" data-mode="document">
        <DocumentSection />
      </div>
    );
  }
  return (
    <div className="properties-panel" data-testid="properties-panel" data-mode="selection">
      <div className="pp-header">
        <span className="pp-icon">{nodeTypeIcon(node)}</span>
        <span className="pp-title" title={info.title}>
          {info.title}
        </span>
        <span className="pp-sub">{info.sub}</span>
      </div>
      <Section title="Transform" collapsible>
        <TransformSection />
      </Section>
      <Section title="Appearance" collapsible>
        <AppearanceSection />
      </Section>
      {info.shapeKind && info.shapeKind !== 'spiral' && info.shapeKind !== 'arc' && (
        <Section title={`${SHAPE_TITLES[info.shapeKind]} properties`} collapsible>
          <ShapeSection ids={info.shapeIds} kind={info.shapeKind} />
        </Section>
      )}
      {info.hasText && (
        <Section title="Text" collapsible>
          <TextSection ids={info.targets} />
        </Section>
      )}
      {info.imageIds.length > 0 && (
        <Section title="Image" collapsible>
          <ImageSection ids={info.imageIds} />
        </Section>
      )}
      <Divider />
      <Section title="Quick actions" collapsible>
        <QuickActions />
      </Section>
    </div>
  );
}
