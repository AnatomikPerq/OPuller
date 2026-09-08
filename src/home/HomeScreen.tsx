/**
 * Home screen (like Illustrator's Home): new-file presets, the project library
 * kept in the browser with thumbnails, recent files from disk, samples, quick
 * tips and the AI connection.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Home, FolderKanban, Clock, Sparkles, GraduationCap, Bot, Search, LayoutGrid, List, Plus, FolderOpen, X, MoreHorizontal, Pencil, Copy, Trash2, Download, ArrowLeft, Settings } from 'lucide-react';
import { useStore, getState } from '@/store/store';
import { runCommand } from '@/commands/registry';
import { Button, Select, IconButton } from '@/ui/widgets';
import { newDocument, loadDocument, confirmDiscard } from '@/io/fileOps';
import { recentEntries, loadRecent, onRecentChanged, removeRecent, clearRecent } from '@/io/recent';
import { downloadText } from '@/util/files';
import { SAMPLES, openSample } from '@/samples/register';
import { useBridgeStore } from '@/mcp/bridge';
import { fitArtboard } from '@/commands/viewCommands';
import { useHomeStore, type HomeSection } from './store';
import { listProjects, projectsSnapshot, onProjectsChanged, loadProject, deleteProject, renameProject, duplicateProject, projectJson, touchProject, saveProject, shouldPersist, makeThumbnail, formatBytes, timeAgo, type ProjectMeta } from './projects';
import { TIPS } from './tips';
import './home.css';

interface Preset {
  id: string;
  name: string;
  hint: string;
  width: number;
  height: number;
  background?: string;
  transparent?: boolean;
}

const NEW_PRESETS: Preset[] = [
  { id: 'a4', name: 'A4', hint: 'Print · 210 × 297 mm', width: 794, height: 1123 },
  { id: 'letter', name: 'US Letter', hint: 'Print · 8.5 × 11 in', width: 816, height: 1056 },
  { id: 'hd', name: 'Full HD', hint: 'Web · 1920 × 1080', width: 1920, height: 1080 },
  { id: 'mobile', name: 'Mobile', hint: 'iPhone · 390 × 844', width: 390, height: 844 },
  { id: 'insta', name: 'Instagram post', hint: 'Social · 1080 × 1080', width: 1080, height: 1080 },
  { id: 'story', name: 'Story / Reel', hint: 'Social · 1080 × 1920', width: 1080, height: 1920 },
  { id: 'icon', name: 'Icon', hint: 'Transparent · 1024 × 1024', width: 1024, height: 1024, transparent: true },
  { id: 'card', name: 'Business card', hint: 'Print · 3.5 × 2 in', width: 336, height: 192 },
];

function useProjects(): ProjectMeta[] {
  const [list, setList] = useState<ProjectMeta[]>(projectsSnapshot());
  useEffect(() => {
    let alive = true;
    void listProjects().then((l) => alive && setList(l));
    const off = onProjectsChanged(() => setList(projectsSnapshot()));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return list;
}

/** The library keeps every document, so switching never loses work: persist, then switch. */
async function persistCurrent(): Promise<void> {
  const s = getState();
  if (s.dirty && shouldPersist(s.doc)) await saveProject(s.doc, { fileName: s.fileName });
}

async function openProject(id: string): Promise<boolean> {
  const s = getState();
  if (s.doc.id === id) return true;
  await persistCurrent();
  const doc = await loadProject(id);
  if (!doc) {
    getState().toast('This project could not be loaded.', 'error');
    return false;
  }
  const meta = projectsSnapshot().find((p) => p.id === id);
  loadDocument(doc, { fileName: meta?.fileName ?? null, remember: false, dirty: false });
  fitArtboard();
  void touchProject(id);
  return true;
}

async function createFromPreset(p: Preset): Promise<boolean> {
  await persistCurrent();
  const doc = newDocument({ name: 'Untitled', width: p.width, height: p.height, background: p.background ?? '#ffffff', transparent: p.transparent ?? false });
  loadDocument(doc, { fileName: null });
  fitArtboard();
  return true;
}

// ---------------------------------------------------------------------------

function NavItem({ id, icon, label, badge }: { id: HomeSection; icon: React.ReactNode; label: string; badge?: number }) {
  const section = useHomeStore((s) => s.section);
  const setSection = useHomeStore((s) => s.setSection);
  return (
    <button type="button" className={`home-nav-item ${section === id ? 'active' : ''}`} onClick={() => setSection(id)} data-testid={`home-nav-${id}`}>
      {icon}
      <span>{label}</span>
      {badge !== undefined && badge > 0 && <em>{badge}</em>}
    </button>
  );
}

function PresetCard({ p, onDone }: { p: Preset; onDone: () => void }) {
  const ratio = Math.min(1.6, Math.max(0.6, p.width / p.height));
  const w = ratio >= 1 ? 56 : 56 * ratio;
  const h = ratio >= 1 ? 56 / ratio : 56;
  return (
    <button
      type="button"
      className="home-preset"
      onClick={async () => {
        if (await createFromPreset(p)) onDone();
      }}
      data-testid={`home-preset-${p.id}`}
    >
      <span className="home-preset-shape">
        <span style={{ width: w, height: h }} />
      </span>
      <b>{p.name}</b>
      <small>{p.hint}</small>
    </button>
  );
}

function ProjectCard({ p, current, view, onOpen }: { p: ProjectMeta; current: boolean; view: 'grid' | 'list'; onOpen: () => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => setName(p.name), [p.name]);
  const commit = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== p.name) void renameProject(p.id, name.trim());
    else setName(p.name);
  };
  const exportFile = async () => {
    const json = await projectJson(p.id);
    if (json) downloadText(json, `${p.name.replace(/[\\/:*?"<>|]+/g, '-') || 'project'}.opuller`, 'application/json');
  };
  const del = async () => {
    if (!confirm(`Delete "${p.name}" from the library? This cannot be undone.`)) return;
    await deleteProject(p.id);
  };
  return (
    <div className={`home-card ${view} ${current ? 'current' : ''}`} data-testid={`home-project-${p.id}`} onDoubleClick={() => !editing && onOpen()}>
      <button type="button" className="home-card-thumb" onClick={() => !editing && onOpen()} title="Open">
        {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <span className="home-card-empty">No preview</span>}
        {current && <span className="home-card-badge">Open now</span>}
      </button>
      <div className="home-card-body">
        {editing ? (
          <input
            ref={inputRef}
            className="home-card-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setName(p.name);
                setEditing(false);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="home-card-name" title="Double-click to rename" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
            {p.name}
          </div>
        )}
        <div className="home-card-meta">
          <span>{timeAgo(p.updated)}</span>
          <span>
            {Math.round(p.width)} × {Math.round(p.height)}
            {p.artboards > 1 ? ` · ${p.artboards} artboards` : ''}
          </span>
          {view === 'list' && (
            <span>
              {p.objects} objects · {formatBytes(p.bytes)}
            </span>
          )}
        </div>
      </div>
      <div className="home-card-actions">
        <IconButton icon={<MoreHorizontal size={14} />} title="More" onClick={() => setMenu((v) => !v)} data-testid={`home-project-menu-${p.id}`} />
        {menu && (
          <div className="home-card-menu" onPointerLeave={() => setMenu(false)}>
            <button type="button" onClick={() => { setMenu(false); onOpen(); }}>
              <FolderOpen size={13} /> Open
            </button>
            <button type="button" onClick={() => { setMenu(false); setEditing(true); }} data-testid="home-project-rename">
              <Pencil size={13} /> Rename
            </button>
            <button type="button" onClick={async () => { setMenu(false); await duplicateProject(p.id); }} data-testid="home-project-duplicate">
              <Copy size={13} /> Duplicate
            </button>
            <button type="button" onClick={() => { setMenu(false); void exportFile(); }}>
              <Download size={13} /> Export .opuller
            </button>
            <button type="button" className="danger" onClick={() => { setMenu(false); void del(); }} data-testid="home-project-delete">
              <Trash2 size={13} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectsGrid({ projects, limit, onOpen }: { projects: ProjectMeta[]; limit?: number; onOpen: (id: string) => void }) {
  const view = useHomeStore((s) => s.view);
  const currentId = useStore((s) => s.doc.id);
  const list = limit ? projects.slice(0, limit) : projects;
  if (!list.length) return <div className="home-empty">No projects yet — create a new file or open one; everything you draw is kept here automatically.</div>;
  return <div className={`home-grid ${view}`}>{list.map((p) => <ProjectCard key={p.id} p={p} current={p.id === currentId} view={view} onOpen={() => onOpen(p.id)} />)}</div>;
}

function SampleCards({ onDone }: { onDone: () => void }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const s of SAMPLES) {
        if (thumbs[s.id]) continue;
        try {
          const t = await makeThumbnail(s.build());
          if (alive && t) setThumbs((m) => ({ ...m, [s.id]: t }));
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="home-grid grid">
      {SAMPLES.map((s) => (
        <div key={s.id} className="home-card grid" data-testid={`home-sample-${s.id}`}>
          <button
            type="button"
            className="home-card-thumb"
            onClick={async () => {
              await persistCurrent();
              if (await openSample(s.id, false)) onDone();
            }}
          >
            {thumbs[s.id] ? <img src={thumbs[s.id]} alt="" /> : <span className="home-card-empty">Preview…</span>}
          </button>
          <div className="home-card-body">
            <div className="home-card-name">{s.name}</div>
            <div className="home-card-meta">
              <span>{s.description}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentFiles() {
  const [list, setList] = useState(recentEntries());
  useEffect(() => onRecentChanged(() => setList(recentEntries())), []);
  const setOpen = useHomeStore((s) => s.setOpen);
  const open = async (id: string) => {
    if (!(await confirmDiscard('open another document'))) return;
    const doc = await loadRecent(id);
    if (!doc) {
      getState().toast('This file is no longer available.', 'error');
      await removeRecent(id);
      return;
    }
    const e = list.find((r) => r.id === id);
    loadDocument(doc, { fileName: e?.fileName ?? null, remember: true });
    fitArtboard();
    setOpen(false);
  };
  if (!list.length) return <div className="home-empty">Files you open or save to disk appear here.</div>;
  return (
    <div className="home-list">
      {list.map((r) => (
        <div key={r.id} className="home-row">
          <FolderOpen size={14} />
          <button type="button" className="home-row-name" onClick={() => open(r.id)}>
            {r.name}
          </button>
          <span className="muted small">{r.fileName ?? 'unsaved'}</span>
          <span className="dim small">{timeAgo(r.time)}</span>
          <IconButton icon={<X size={13} />} title="Remove from the list" onClick={() => void removeRecent(r.id)} />
        </div>
      ))}
      <div>
        <Button small onClick={() => void clearRecent()}>
          Clear list
        </Button>
      </div>
    </div>
  );
}

export function HomeScreen() {
  const open = useHomeStore((s) => s.open);
  const section = useHomeStore((s) => s.section);
  const setOpen = useHomeStore((s) => s.setOpen);
  const setSection = useHomeStore((s) => s.setSection);
  const query = useHomeStore((s) => s.query);
  const setQuery = useHomeStore((s) => s.setQuery);
  const view = useHomeStore((s) => s.view);
  const setView = useHomeStore((s) => s.setView);
  const sort = useHomeStore((s) => s.sort);
  const setSort = useHomeStore((s) => s.setSort);
  const projects = useProjects();
  const docName = useStore((s) => s.doc.name);
  const docId = useStore((s) => s.doc.id);
  const dirty = useStore((s) => s.dirty);
  const hasWork = useStore((s) => shouldPersist(s.doc));
  const connected = useBridgeStore((s) => s.connected);

  // keep the current document's card fresh when the screen opens
  useEffect(() => {
    if (!open) return;
    const s = getState();
    if (shouldPersist(s.doc)) void saveProject(s.doc, { fileName: s.fileName });
  }, [open, docId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && hasWork) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hasWork, setOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || (p.fileName ?? '').toLowerCase().includes(q)) : projects.slice();
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'created') list.sort((a, b) => b.created - a.created);
    else list.sort((a, b) => b.updated - a.updated);
    return list;
  }, [projects, query, sort]);

  if (!open) return null;
  const close = () => setOpen(false);
  const openId = async (id: string) => {
    if (await openProject(id)) close();
  };
  const titles: Record<HomeSection, string> = { home: 'Home', projects: 'Projects', recent: 'Recent files', samples: 'Samples', learn: 'Learn', ai: 'Connect an AI' };

  return (
    <div className="home" data-testid="home-screen">
      <aside className="home-side">
        <div className="home-brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <b>OPuller</b>
            <small>Vector editor</small>
          </div>
        </div>
        <Button primary className="home-new-btn" onClick={() => { close(); getState().openDialog('newDocument'); }} data-testid="home-new-custom">
          <Plus size={14} /> New file…
        </Button>
        <Button className="home-new-btn" onClick={() => { close(); runCommand('file.open'); }}>
          <FolderOpen size={14} /> Open…
        </Button>
        <nav className="home-nav">
          <NavItem id="home" icon={<Home size={15} />} label="Home" />
          <NavItem id="projects" icon={<FolderKanban size={15} />} label="Projects" badge={projects.length} />
          <NavItem id="recent" icon={<Clock size={15} />} label="Recent files" />
          <NavItem id="samples" icon={<Sparkles size={15} />} label="Samples" />
          <NavItem id="learn" icon={<GraduationCap size={15} />} label="Learn" />
          <NavItem id="ai" icon={<Bot size={15} />} label={connected ? 'AI · connected' : 'Connect an AI'} />
        </nav>
        <div className="home-side-footer">
          <button type="button" className="home-link" onClick={() => { close(); runCommand('edit.preferences'); }}>
            <Settings size={13} /> Preferences
          </button>
          <span className="dim small">v0.1.0</span>
        </div>
      </aside>
      <main className="home-main">
        <header className="home-header">
          <h1>{titles[section]}</h1>
          {(section === 'projects' || section === 'home') && (
            <div className="home-search">
              <Search size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" data-testid="home-search" />
            </div>
          )}
          {section === 'projects' && (
            <>
              <Select value={sort} options={[{ value: 'updated', label: 'Last modified' }, { value: 'name', label: 'Name' }, { value: 'created', label: 'Created' }]} onChange={(v) => setSort(v as any)} width={140} />
              <IconButton icon={<LayoutGrid size={14} />} active={view === 'grid'} title="Grid" onClick={() => setView('grid')} />
              <IconButton icon={<List size={14} />} active={view === 'list'} title="List" onClick={() => setView('list')} />
            </>
          )}
          <span className="grow" />
          {hasWork && (
            <Button onClick={close} title="Return to the open document (Esc)" data-testid="home-back">
              <ArrowLeft size={14} /> Back to {dirty ? '• ' : ''}
              {docName}
            </Button>
          )}
          {!hasWork && (
            <Button onClick={close} title="Close the Home screen" data-testid="home-close">
              <X size={14} /> Close
            </Button>
          )}
        </header>
        <div className="home-content">
          {section === 'home' && (
            <>
              <h2>Start a new file</h2>
              <div className="home-presets">
                <button type="button" className="home-preset custom" onClick={() => { close(); getState().openDialog('newDocument'); }} data-testid="home-preset-custom">
                  <span className="home-preset-shape">
                    <Plus size={22} />
                  </span>
                  <b>Custom size…</b>
                  <small>All presets & units</small>
                </button>
                {NEW_PRESETS.map((p) => (
                  <PresetCard key={p.id} p={p} onDone={close} />
                ))}
              </div>
              <h2>
                Recent projects
                {projects.length > 8 && (
                  <button type="button" className="home-link" onClick={() => setSection('projects')}>
                    See all ({projects.length})
                  </button>
                )}
              </h2>
              <ProjectsGrid projects={filtered} limit={8} onOpen={openId} />
              <h2>Samples</h2>
              <SampleCards onDone={close} />
            </>
          )}
          {section === 'projects' && (
            <>
              <div className="muted small home-note">Projects are stored in this browser (IndexedDB) with a preview and update automatically while you work. Export a project as an .opuller file to move it elsewhere.</div>
              <ProjectsGrid projects={filtered} onOpen={openId} />
            </>
          )}
          {section === 'recent' && <RecentFiles />}
          {section === 'samples' && <SampleCards onDone={close} />}
          {section === 'learn' && (
            <div className="home-tips">
              {TIPS.map(([k, v]) => (
                <div key={k} className="tip">
                  <b>{k}</b>
                  <span>{v}</span>
                </div>
              ))}
              <div className="tip">
                <b>Shortcuts</b>
                <span>
                  <button type="button" className="home-link" onClick={() => { close(); runCommand('help.shortcuts'); }}>
                    Open the full keyboard shortcut list (Ctrl+/)
                  </button>
                </span>
              </div>
            </div>
          )}
          {section === 'ai' && (
            <div className="home-ai">
              <p>
                OPuller has an <b>MCP server</b>: Claude (Claude Code, Claude Desktop) or any MCP client can read the document, create and edit objects, run every command and tool, simulate mouse gestures and look at
                the result as an image. Status: <b>{connected ? 'connected' : 'waiting for a server'}</b>.
              </p>
              <Button primary onClick={() => { close(); getState().openDialog('mcpSetup', {}); }}>
                <Bot size={14} /> Setup instructions
              </Button>
              <ol>
                <li>Keep the editor open in this browser tab.</li>
                <li>
                  Add the server to your AI client — Claude Code reads <code>.mcp.json</code> from the project folder; others use <code>node mcp/server.ts</code>.
                </li>
                <li>Ask for anything: "draw a bird from circles", "make the logo 20% wider", "export every artboard as PNG".</li>
              </ol>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
