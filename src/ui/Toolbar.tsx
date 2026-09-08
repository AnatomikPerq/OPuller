import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import { toolGroups, onToolsChanged, allTools, type Tool } from '@/tools/registry';
import { shortcutLabel } from '@/util/keys';
import { PaintIndicator } from './PaintIndicator';
import { Tooltip } from './widgets';

/** Remember which tool of a group was used last so the toolbar shows it. */
const lastInGroup = new Map<string, string>();

export function Toolbar() {
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  useSyncExternalStore(onToolsChanged, () => allTools().length, () => 0);
  const groups = toolGroups();
  const [flyout, setFlyout] = useState<string | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<number | null>(null);

  useEffect(() => {
    const t = allTools().find((x) => x.id === activeTool);
    if (t) lastInGroup.set(t.group, t.id);
  }, [activeTool]);

  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: PointerEvent) => {
      if (flyoutRef.current?.contains(e.target as HTMLElement)) return;
      setFlyout(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [flyout]);

  const pick = (t: Tool) => {
    setTool(t.id);
    lastInGroup.set(t.group, t.id);
    setFlyout(null);
  };

  return (
    <div className="toolbar" data-testid="toolbar">
      {groups.map((g, gi) => {
        const shownId = g.tools.some((t) => t.id === activeTool) ? activeTool : (lastInGroup.get(g.id) ?? g.tools[0].id);
        const shown = g.tools.find((t) => t.id === shownId) ?? g.tools[0];
        const Icon = shown.icon;
        const isActive = g.tools.some((t) => t.id === activeTool);
        const prevGroup = groups[gi - 1];
        const sep = prevGroup && Math.floor(prevGroup.tools[0].order / 100) !== Math.floor(g.tools[0].order / 100);
        return (
          <React.Fragment key={g.id}>
            {sep && <div className="toolbar-sep" />}
            <div style={{ position: 'relative' }}>
              <Tooltip text={shown.name} shortcut={shortcutLabel(shown.shortcut)}>
                <button
                  className={`tool-btn ${isActive ? 'active' : ''}`}
                  data-testid={`tool-${shown.id}`}
                  data-group={g.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if (g.tools.length > 1) {
                      pressTimer.current = window.setTimeout(() => setFlyout(g.id), 350);
                    }
                  }}
                  onPointerUp={() => {
                    if (pressTimer.current) {
                      clearTimeout(pressTimer.current);
                      pressTimer.current = null;
                    }
                  }}
                  onPointerLeave={() => {
                    if (pressTimer.current) {
                      clearTimeout(pressTimer.current);
                      pressTimer.current = null;
                    }
                  }}
                  onClick={() => {
                    if (flyout === g.id) return;
                    pick(shown);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (g.tools.length > 1) setFlyout(g.id);
                  }}
                  onDoubleClick={() => g.tools.length > 1 && setFlyout(g.id)}
                >
                  <Icon size={18} strokeWidth={1.75} />
                  {g.tools.length > 1 && <span className="flyout-mark" />}
                </button>
              </Tooltip>
              {flyout === g.id && (
                <div className="tool-flyout" ref={flyoutRef} data-testid={`flyout-${g.id}`}>
                  {g.tools.map((t) => {
                    const I = t.icon;
                    return (
                      <button key={t.id} className={`flyout-item ${t.id === activeTool ? 'active' : ''}`} onClick={() => pick(t)} data-testid={`flyout-tool-${t.id}`}>
                        <I size={16} strokeWidth={1.75} />
                        <span>{t.name}</span>
                        {t.shortcut && <span className="shortcut">{shortcutLabel(t.shortcut)}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
      <div className="toolbar-sep" />
      <PaintIndicator />
    </div>
  );
}
