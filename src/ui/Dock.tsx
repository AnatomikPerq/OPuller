import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore, getState } from '@/store/store';
import { getPanel, onPanelsChanged, panelsSnapshot } from './panels/registry';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

/**
 * Right dock: groups of tabbed panels. The layout (array of groups of panel ids)
 * is persisted; hidden panels (via Window menu) are skipped.
 */
export function Dock() {
  const layout = useStore((s) => s.panelLayout);
  const panels = useStore((s) => s.panels);
  const width = useStore((s) => s.rightDockWidth);
  const setWidth = useStore((s) => s.setRightDockWidth);
  useSyncExternalStore(onPanelsChanged, () => panelsSnapshot().length, () => 0);
  const dragging = useRef<{ startX: number; startW: number } | null>(null);

  // panels registered but not in the layout go to a trailing group
  const known = new Set(layout.flat());
  const extra = panelsSnapshot().filter((p) => !known.has(p.id)).map((p) => p.id);
  const groups = extra.length ? [...layout, extra] : layout;

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(dragging.current.startW - (e.clientX - dragging.current.startX));
    };
    const up = () => (dragging.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [setWidth]);

  const visibleGroups = groups
    .map((g) => g.filter((id) => getPanel(id) && (panels[id] ?? getPanel(id)!.defaultVisible ?? true)))
    .filter((g) => g.length);

  return (
    <div className="dock" style={{ width }} data-testid="dock">
      <div className="dock-resizer" onPointerDown={(e) => (dragging.current = { startX: e.clientX, startW: width })} />
      <div className="dock-scroll">
        {visibleGroups.map((g, i) => (
          <PanelGroup key={g.join('|')} ids={g} index={i} />
        ))}
        {!visibleGroups.length && <div className="empty-hint">All panels are hidden. Use the Window menu to show them.</div>}
      </div>
    </div>
  );
}

function PanelGroup({ ids, index }: { ids: string[]; index: number }) {
  const [active, setActive] = useState(ids[0]);
  const [collapsed, setCollapsed] = useState(false);
  const current = ids.includes(active) ? active : ids[0];
  const def = getPanel(current);
  const Comp = def?.component;
  return (
    <div className={`panel-group ${collapsed ? 'collapsed' : ''}`} data-testid={`panel-group-${index}`}>
      <div className="panel-tabs" role="tablist">
        {ids.map((id) => {
          const p = getPanel(id);
          if (!p) return null;
          return (
            <button key={id} role="tab" aria-selected={id === current} className={`panel-tab ${id === current ? 'active' : ''}`} onClick={() => { setActive(id); setCollapsed(false); }} onDoubleClick={() => setCollapsed(!collapsed)} data-testid={`panel-tab-${id}`}>
              {p.title}
            </button>
          );
        })}
        <button className="panel-menu-btn" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button className="panel-menu-btn" title="Hide panel" onClick={() => getState().togglePanel(current, false)}>
          <X size={13} />
        </button>
      </div>
      {!collapsed && Comp && (
        <div className="panel-body" data-testid={`panel-${current}`}>
          <ErrorBoundary key={current}>
            <Comp />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty-hint" style={{ color: 'var(--danger)' }}>
          Panel error: {this.state.error.message}
          <div>
            <button className="btn small" style={{ marginTop: 6 }} onClick={() => this.setState({ error: null })}>
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
