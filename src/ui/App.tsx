import React, { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import { appOverlaysSnapshot, onAppOverlaysChanged } from './appSlots';
import { MenuBar } from './MenuBar';
import { Toolbar } from './Toolbar';
import { ControlBar } from './ControlBar';
import { StatusBar } from './StatusBar';
import { Dock } from './Dock';
import { ContextMenuHost } from './ContextMenu';
import { Toasts } from './Toasts';
import { DialogHost } from './DialogHost';
import { Viewport } from '@/canvas/Viewport';
import { installShortcuts } from './shortcuts';
import { ErrorBoundary } from './Dock';

export function App() {
  const theme = useStore((s) => s.prefs.theme);
  const uiScale = useStore((s) => s.prefs.uiScale);
  const leftCollapsed = useStore((s) => s.leftDockCollapsed);

  const overlays = useSyncExternalStore(onAppOverlaysChanged, appOverlaysSnapshot, appOverlaysSnapshot);

  useEffect(() => installShortcuts(), []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  }, [theme, uiScale]);

  // warn before leaving with unsaved changes
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <div className={`app ${leftCollapsed ? 'left-collapsed' : ''}`} data-testid="app">
      <ErrorBoundary>
        <MenuBar />
      </ErrorBoundary>
      <ErrorBoundary>
        <ControlBar />
      </ErrorBoundary>
      <ErrorBoundary>
        <Toolbar />
      </ErrorBoundary>
      <div className="canvas-area">
        <ErrorBoundary>
          <Viewport />
        </ErrorBoundary>
      </div>
      <ErrorBoundary>
        <Dock />
      </ErrorBoundary>
      <ErrorBoundary>
        <StatusBar />
      </ErrorBoundary>
      <ContextMenuHost />
      <DialogHost />
      <Toasts />
      {overlays.map((o) => (
        <ErrorBoundary key={o.id}>
          <o.component />
        </ErrorBoundary>
      ))}
    </div>
  );
}
