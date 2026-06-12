import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import {
  Braces,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  Crown,
  Download,
  FilePlus2,
  Folder,
  FolderPlus,
  Lock,
  Menu,
  MoreVertical,
  Pencil,
  Plus,
  Send,
  Share2,
  Trash2,
  UserPlus,
  Users,
  Wifi,
  X
} from 'lucide-react';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import JSZip from 'jszip';
import { nanoid } from 'nanoid';
import './styles.css';

const WS_URL = import.meta.env.VITE_WS_URL
  || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const COLORS = ['#8b5cf6', '#22c55e', '#f97316', '#ec4899', '#38bdf8', '#facc15', '#14b8a6'];

const EXTENSIONS = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  html: 'html',
  css: 'css',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell'
};

function languageFor(file) {
  const ext = file?.name?.split('.').pop()?.toLowerCase();
  return EXTENSIONS[ext] || 'plaintext';
}

function fileToken(file) {
  const ext = file?.name?.split('.').pop()?.toLowerCase() || '';
  if (ext === 'js') return 'JS';
  if (ext === 'ts') return 'TS';
  if (ext === 'css' || ext === 'json') return '{}';
  if (ext === 'html') return '<>';
  if (ext === 'md') return 'MD';
  return ext.slice(0, 2).toUpperCase() || 'F';
}

function getInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function shortTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function uint8ToBase64(update) {
  let binary = '';
  update.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToUint8(update) {
  const binary = atob(update);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function useLocalIdentity() {
  return useMemo(() => {
    const existing = localStorage.getItem('collab-code-identity');
    if (existing) return JSON.parse(existing);
    const samples = ['Arjun T.', 'Neha S.', 'Rohan K.', 'Priya M.', 'Dev P.'];
    const identity = {
      clientId: nanoid(10),
      name: samples[Math.floor(Math.random() * samples.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    };
    localStorage.setItem('collab-code-identity', JSON.stringify(identity));
    return identity;
  }, []);
}

function App() {
  const identity = useLocalIdentity();
  const queryRoom = new URLSearchParams(location.search).get('room');
  const [name, setName] = useState(identity.name);
  const [entered, setEntered] = useState(Boolean(queryRoom));
  const [roomId, setRoomId] = useState(queryRoom || `workspace-${nanoid(4)}`);
  const [status, setStatus] = useState('disconnected');
  const [clientId, setClientId] = useState(identity.clientId);
  const [hostClientId, setHostClientId] = useState(null);
  const [users, setUsers] = useState([]);
  const [folders, setFolders] = useState(['src', 'docs', 'config']);
  const [files, setFiles] = useState([]);
  const [activeFileId, setActiveFileId] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('src');
  const [collapsedFolders, setCollapsedFolders] = useState(new Set());
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState('');
  const [profileEditing, setProfileEditing] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(320);
  const [sideWidth, setSideWidth] = useState(320);
  const [explorerInput, setExplorerInput] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [notice, setNotice] = useState('');
  const [draggedFileId, setDraggedFileId] = useState(null);
  const [dropTargetFolder, setDropTargetFolder] = useState(null);
  const [remoteCursors, setRemoteCursors] = useState(new Map());
  const socketRef = useRef(null);
  const exportRequestsRef = useRef(new Map());
  const docsRef = useRef(new Map());
  const bindingsRef = useRef(new Map());
  const providerRef = useRef({ awareness: null });
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const canEditRef = useRef(false);
  const activeFileIdRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const decorationsRef = useRef([]);

  const activeFile = files.find((file) => file.id === activeFileId);
  const me = users.find((user) => user.clientId === clientId);
  const isHost = hostClientId === clientId;
  const canEdit = me?.role === 'editor' || isHost;
  const allFolders = [...new Set([...folders, ...files.map((file) => file.folder || 'src')])];
  const groupedFiles = allFolders.map((folder) => ({
    folder,
    files: files.filter((file) => (file.folder || 'src') === folder)
  }));

  useEffect(() => {
    if (!entered) return undefined;

    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({ type: 'join', roomId, clientId: identity.clientId, name, color: identity.color }));
      history.replaceState(null, '', `?room=${roomId}`);
    };

    ws.onclose = () => {
      setStatus('disconnected');
      for (const request of exportRequestsRef.current.values()) request.reject?.(new Error('Connection closed.'));
      exportRequestsRef.current.clear();
    };
    ws.onerror = () => setStatus('error');
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'joined') {
        setClientId(message.clientId);
        setRoomId(message.roomId);
      }

      if (message.type === 'room-state') {
        const nextFolders = message.folders || [...new Set(message.files.map((file) => file.folder || 'src'))];
        setHostClientId(message.hostClientId);
        setUsers(message.users);
        setFolders(nextFolders);
        setFiles(message.files);
        setChat(message.chat);
        setActiveFileId((current) => message.files.some((file) => file.id === current) ? current : (message.files[0]?.id || null));
        setOpenTabs((tabs) => {
          const validTabs = tabs.filter((tabId) => message.files.some((file) => file.id === tabId));
          return validTabs.length ? validTabs : message.files.slice(0, 1).map((file) => file.id);
        });
        setSelectedFolder((current) => nextFolders.includes(current) ? current : (nextFolders[0] || 'src'));
      }

      if (message.type === 'file-sync' || message.type === 'y-update') {
        const doc = getDoc(message.fileId);
        applyingRemoteRef.current = true;
        Y.applyUpdate(doc, base64ToUint8(message.update));
        applyingRemoteRef.current = false;
      }

      if (message.type === 'chat') {
        setChat((items) => [...items, message.message].slice(-100));
      }

      if (message.type === 'cursor') {
        setRemoteCursors((next) => new Map(next).set(message.clientId, message));
      }

      if (message.type === 'cursor-clear') {
        setRemoteCursors((next) => {
          const copy = new Map(next);
          copy.delete(message.clientId);
          return copy;
        });
      }

      if (message.type === 'workspace-export') {
        const request = exportRequestsRef.current.get(message.requestId);
        if (request) {
          exportRequestsRef.current.delete(message.requestId);
          request.resolve(message);
        }
      }
    };

    return () => ws.close();
  }, [entered]);

  useEffect(() => {
    localStorage.setItem('collab-code-identity', JSON.stringify({ ...identity, name }));
  }, [name]);

  useEffect(() => {
    canEditRef.current = canEdit;
  }, [canEdit]);

  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);

  useEffect(() => {
    if (!activeFileId || openTabs.includes(activeFileId)) return;
    setOpenTabs((tabs) => [...tabs, activeFileId]);
  }, [activeFileId, openTabs]);

  useEffect(() => {
    if (!activeFileId || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: 'request-file', fileId: activeFileId }));
  }, [activeFileId]);

  useEffect(() => {
    renderRemoteCursors();
  }, [remoteCursors, activeFileId, users]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeFileId) return;

    bindingsRef.current.get('active')?.destroy();
    const model = monaco.editor.createModel(getDoc(activeFileId).getText('content').toString(), languageFor(activeFile));
    editor.setModel(model);
    editor.updateOptions({ readOnly: !canEdit });
    const binding = new MonacoBinding(getDoc(activeFileId).getText('content'), model, new Set([editor]), providerRef.current.awareness);
    bindingsRef.current.set('active', binding);

    return () => {
      binding.destroy();
      model.dispose();
    };
  }, [activeFileId, canEdit]);

  function getDoc(fileId) {
    if (!docsRef.current.has(fileId)) {
      const doc = new Y.Doc();
      doc.on('update', (update) => {
        if (applyingRemoteRef.current || !canEditRef.current) return;
        const ws = socketRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'y-update', fileId, update: uint8ToBase64(update) }));
        }
      });
      docsRef.current.set(fileId, doc);
    }
    return docsRef.current.get(fileId);
  }

  function handleEditorMount(editor, monaco) {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidChangeCursorSelection((event) => {
      const ws = socketRef.current;
      const fileId = activeFileIdRef.current;
      if (!fileId || ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'cursor', fileId, position: event.position, selection: event.selection }));
    });
  }

  function renderRemoteCursors() {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeFileId) return;
    const decorations = [];
    for (const cursor of remoteCursors.values()) {
      if (cursor.fileId !== activeFileId || cursor.clientId === clientId) continue;
      const user = users.find((item) => item.clientId === cursor.clientId);
      if (!user || !cursor.position) continue;
      decorations.push({
        range: new monaco.Range(cursor.position.lineNumber, cursor.position.column, cursor.position.lineNumber, cursor.position.column),
        options: {
          className: 'remote-cursor',
          hoverMessage: { value: user.name },
          after: { content: user.name, inlineClassName: 'remote-cursor-label' }
        }
      });
      if (cursor.selection) {
        decorations.push({
          range: new monaco.Range(cursor.selection.startLineNumber, cursor.selection.startColumn, cursor.selection.endLineNumber, cursor.selection.endColumn),
          options: { className: 'remote-selection' }
        });
      }
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }

  function send(type, payload = {}) {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  }

  function beginCreateFile(folder = selectedFolder) {
    setExplorerInput({ type: 'file-create', folder, value: folder === 'docs' ? 'notes.md' : 'main.js' });
  }

  function beginCreateFolder() {
    setExplorerInput({ type: 'folder-create', value: 'features' });
  }

  function beginRenameFile(file) {
    setExplorerInput({ type: 'file-rename', fileId: file.id, folder: file.folder || 'src', value: file.name });
  }

  function requestDeleteFile(file) {
    setDeleteCandidate(file);
  }

  function commitExplorerInput(event) {
    event?.preventDefault();
    const value = explorerInput?.value?.trim();
    if (!value) {
      setExplorerInput(null);
      return;
    }

    if (explorerInput.type === 'file-create') {
      send('file-create', { name: value, folder: explorerInput.folder || selectedFolder });
    }
    if (explorerInput.type === 'folder-create') {
      send('folder-create', { name: value });
    }
    if (explorerInput.type === 'file-rename') {
      send('file-rename', { fileId: explorerInput.fileId, name: value });
    }

    setExplorerInput(null);
  }

  function cancelExplorerInput() {
    setExplorerInput(null);
  }

  function confirmDeleteFile() {
    if (!deleteCandidate) return;
    send('file-delete', { fileId: deleteCandidate.id });
    setDeleteCandidate(null);
  }

  function moveFileToFolder(fileId, folder) {
    const file = files.find((item) => item.id === fileId);
    if (!file || file.folder === folder) return;
    send('file-move', { fileId, folder });
    setSelectedFolder(folder);
  }

  function handleFileDragStart(file, event) {
    if (!canEdit) return;
    setDraggedFileId(file.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', file.id);
  }

  function handleFolderDragOver(folder, event) {
    if (!canEdit || !draggedFileId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetFolder(folder);
  }

  function handleFolderDrop(folder, event) {
    event.preventDefault();
    event.stopPropagation();
    const fileId = event.dataTransfer.getData('text/plain') || draggedFileId;
    moveFileToFolder(fileId, folder);
    setDraggedFileId(null);
    setDropTargetFolder(null);
  }

  function clearDragState() {
    setDraggedFileId(null);
    setDropTargetFolder(null);
  }

  function downloadBlob(name, content, type = 'application/octet-stream') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function requestWorkspaceExport() {
    const ws = socketRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ roomId, folders, files: files.map((file) => ({ ...file, content: getDoc(file.id).getText('content').toString() })) });
    }

    const requestId = nanoid(10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        exportRequestsRef.current.delete(requestId);
        reject(new Error('Workspace export timed out.'));
      }, 8000);

      exportRequestsRef.current.set(requestId, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      ws.send(JSON.stringify({ type: 'workspace-export', requestId }));
    });
  }

  async function exportWorkspace() {
    try {
      const workspace = await requestWorkspaceExport();
      const zip = new JSZip();

      for (const folder of workspace.folders) {
        zip.folder(folder);
      }

      for (const file of workspace.files) {
        const path = `${file.folder || 'src'}/${file.name}`.replace(/^\/+/, '');
        zip.file(path, file.content || '');
      }

      zip.file('collab-workspace.json', JSON.stringify({
        roomId: workspace.roomId || roomId,
        exportedAt: new Date().toISOString(),
        folders: workspace.folders,
        files: workspace.files.map(({ id, name, folder, path, type }) => ({ id, name, folder, path, type }))
      }, null, 2));

      const archive = await zip.generateAsync({ type: 'blob' });
      downloadBlob(`${workspace.roomId || roomId}.zip`, archive, 'application/zip');
    } catch (error) {
      setNotice(error.message || 'Workspace export failed.');
      window.setTimeout(() => setNotice(''), 3000);
    }
  }

  function exportFile(file) {
    downloadBlob(file.name, getDoc(file.id).getText('content').toString(), 'text/plain');
  }

  function sendChat(event) {
    event.preventDefault();
    if (!chatText.trim()) return;
    send('chat', { text: chatText });
    setChatText('');
  }

  function closeTab(tabId, event) {
    event.stopPropagation();
    setOpenTabs((tabs) => {
      const next = tabs.filter((id) => id !== tabId);
      if (activeFileId === tabId) setActiveFileId(next[0] || files.find((file) => file.id !== tabId)?.id || null);
      return next;
    });
  }

  function toggleFolder(folder) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  function copyInvite() {
    navigator.clipboard?.writeText(location.href);
  }

  function changeName() {
    setProfileNameDraft(name);
    setProfileEditing(true);
  }

  function commitNameChange(event) {
    event.preventDefault();
    const cleanName = profileNameDraft.trim().slice(0, 32);
    if (cleanName) {
      setName(cleanName);
      send('name-update', { name: cleanName });
    }
    setProfileEditing(false);
    setProfileOpen(false);
  }

  function leaveRoom() {
    socketRef.current?.close();
    setEntered(false);
    setUsers([]);
    setFiles([]);
    setOpenTabs([]);
    setProfileOpen(false);
  }

  function startResize(panel, event) {
    event.preventDefault();
    const startX = event.clientX;
    const startExplorer = explorerWidth;
    const startSide = sideWidth;

    function onMove(moveEvent) {
      if (panel === 'explorer') {
        const next = Math.min(460, Math.max(240, startExplorer + moveEvent.clientX - startX));
        setExplorerWidth(next);
      } else {
        const next = Math.min(460, Math.max(260, startSide + startX - moveEvent.clientX));
        setSideWidth(next);
      }
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  if (!entered) {
    return (
      <main className="join-screen">
        <section className="join-panel">
          <div className="join-brand">
            <span className="brand-mark"><Code2 size={25} /></span>
            <div>
              <p className="eyebrow">Live collaborative coding</p>
              <h1>Collab Code IDE</h1>
            </div>
          </div>
          <p className="join-copy">Open a shared room with live files, cursors, role controls, and chat.</p>
          <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Room ID<input value={roomId} onChange={(event) => setRoomId(event.target.value)} /></label>
          <button onClick={() => setEntered(true)}>Join workspace</button>
        </section>
      </main>
    );
  }

  return (
    <div
      className={leftCollapsed ? 'app left-collapsed' : 'app'}
      style={{ '--explorer-width': `${explorerWidth}px`, '--side-width': `${sideWidth}px` }}
    >
      <header className="topbar">
        <button className="icon-button ghost" aria-label="Menu" onClick={() => setLeftCollapsed((value) => !value)}><Menu size={21} /></button>
        <div className="live-pill"><span />Live Room</div>
        <button className="workspace-id" onClick={copyInvite}>{roomId}<Lock size={15} /></button>
        <div className="topbar-spacer" />
        <button className="share-button" onClick={copyInvite}><Share2 size={15} />Share</button>
        <button className="top-button" onClick={copyInvite}><Copy size={15} />Copy link</button>
        <button className="top-button"><Users size={15} />{users.length}</button>
        <button className="profile-chip" style={{ '--avatar-color': identity.color }} onClick={() => setProfileOpen((value) => !value)}>
          <span>{getInitials(name)}</span><b>{name}</b><ChevronDown size={16} />
        </button>
        {profileOpen && (
          <div className="profile-menu">
            {profileEditing ? (
              <form className="profile-inline-form" onSubmit={commitNameChange}>
                <input value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} autoFocus />
              </form>
            ) : (
              <button onClick={changeName}>Change display name</button>
            )}
            <button onClick={leaveRoom}>Leave room</button>
          </div>
        )}
        {notice && <div className="app-notice">{notice}</div>}
      </header>

      <aside className="explorer">
        <div className="panel-head explorer-head"><span>Explorer</span><MoreVertical size={18} /></div>
        <div className="explorer-actions">
          <button disabled={!canEdit} onClick={() => beginCreateFile(selectedFolder)}><FilePlus2 size={18} />New file</button>
          <button disabled={!canEdit} onClick={beginCreateFolder}><FolderPlus size={18} />New folder</button>
          <button onClick={exportWorkspace} title="Export workspace"><Download size={18} /></button>
        </div>
        <div className="project-title"><ChevronDown size={16} /><span>{roomId}</span><small>{users.length} online</small></div>
        <div className="file-tree">
          {explorerInput?.type === 'folder-create' && (
            <div className="file input-file root-input">
              <InlineExplorerInput
                input={explorerInput}
                setInput={setExplorerInput}
                onSubmit={commitExplorerInput}
                onCancel={cancelExplorerInput}
              />
            </div>
          )}
          {groupedFiles.map((group) => (
            <section className={group.folder === selectedFolder ? 'tree-group selected-folder' : 'tree-group'} key={group.folder}>
              <button
                className={dropTargetFolder === group.folder ? 'folder-row drop-target' : 'folder-row'}
                onClick={() => { setSelectedFolder(group.folder); toggleFolder(group.folder); }}
                onDragOver={(event) => handleFolderDragOver(group.folder, event)}
                onDragLeave={() => setDropTargetFolder(null)}
                onDrop={(event) => handleFolderDrop(group.folder, event)}
              >
                <ChevronDown size={16} className={collapsedFolders.has(group.folder) ? 'chevron collapsed' : 'chevron'} />
                <Folder size={16} />
                <span>{group.folder}</span>
              </button>
              {explorerInput && explorerInput.type === 'file-create' && explorerInput.folder === group.folder && (
                <InlineExplorerInput
                  input={explorerInput}
                  setInput={setExplorerInput}
                  onSubmit={commitExplorerInput}
                  onCancel={cancelExplorerInput}
                />
              )}
              {!collapsedFolders.has(group.folder) && group.files.map((file) => (
                explorerInput?.type === 'file-rename' && explorerInput.fileId === file.id ? (
                  <div className="file input-file" key={file.id}>
                    <InlineExplorerInput
                      input={explorerInput}
                      setInput={setExplorerInput}
                      onSubmit={commitExplorerInput}
                      onCancel={cancelExplorerInput}
                    />
                  </div>
                ) : (
                  <button
                    key={file.id}
                    className={file.id === activeFileId ? 'file active' : 'file'}
                    draggable={canEdit}
                    onDragStart={(event) => handleFileDragStart(file, event)}
                    onDragEnd={clearDragState}
                    onClick={() => { setSelectedFolder(file.folder || 'src'); setActiveFileId(file.id); }}
                  >
                      <span className={`file-token ${languageFor(file)}`}>{fileToken(file)}</span>
                      <span>{file.name}</span>
                      <small className={`activity-dot ${languageFor(file)}`} />
                      {canEdit && (
                        <span className="file-actions">
                          <Pencil size={15} onClick={(event) => { event.stopPropagation(); beginRenameFile(file); }} />
                          <Download size={15} onClick={(event) => { event.stopPropagation(); exportFile(file); }} />
                          <Trash2 size={15} onClick={(event) => { event.stopPropagation(); requestDeleteFile(file); }} />
                        </span>
                      )}
                  </button>
                )
              ))}
            </section>
          ))}
        </div>
        {deleteCandidate && (
          <div className="delete-confirm">
            <span>Delete {deleteCandidate.name}?</span>
            <button onClick={confirmDeleteFile}>Delete</button>
            <button onClick={() => setDeleteCandidate(null)}>Cancel</button>
          </div>
        )}
      </aside>
      <div className="resize-handle explorer-resize" onMouseDown={(event) => startResize('explorer', event)} />

      <main className="workspace">
        <nav className="tabs">
          {openTabs.map((tabId) => {
            const file = files.find((item) => item.id === tabId);
            if (!file) return null;
            return (
              <button key={tabId} className={tabId === activeFileId ? 'tab active' : 'tab'} onClick={() => setActiveFileId(tabId)}>
                <span className={`file-token ${languageFor(file)}`}>{fileToken(file)}</span>
                {file.name}
                <span className="tab-close" onClick={(event) => closeTab(tabId, event)}><X size={16} /></span>
              </button>
            );
          })}
          <button className="tab add-tab" onClick={() => beginCreateFile(selectedFolder)}><Plus size={19} /></button>
          <button className="tab menu-tab"><MoreVertical size={18} /></button>
        </nav>
        <div className="editor-shell">
          <Editor
            height="100%"
            theme="vs-dark"
            language={languageFor(activeFile)}
            options={{
              readOnly: !canEdit,
              fontSize: 14,
              lineHeight: 22,
              minimap: { enabled: true, side: 'right' },
              automaticLayout: true,
              formatOnPaste: true,
              formatOnType: true,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              padding: { top: 14 }
            }}
            onMount={handleEditorMount}
          />
        </div>
        <footer className="statusbar">
          <span>Ln 22, Col 1</span><span>Spaces: 2</span><span>UTF-8</span><span>LF</span><span><Braces size={15} />{languageFor(activeFile)}</span><span className="connection"><Wifi size={15} /> {status === 'connected' ? 'Connected' : status}</span>
        </footer>
      </main>

      <div className="resize-handle side-resize" onMouseDown={(event) => startResize('side', event)} />
      <aside className="sidepanel">
        <div className="side-title">People</div>
        <section className="people-pane">
          <div className="room-row"><span><CheckCircle2 size={16} /> Live Room</span><small>{users.length} online</small></div>
          <UserGroup title="Host" users={users.filter((user) => user.isHost)} clientId={clientId} isHost={isHost} onRole={(targetClientId, role) => send('role-set', { targetClientId, role })} />
          <UserGroup title="Editors" users={users.filter((user) => !user.isHost && user.role === 'editor')} clientId={clientId} isHost={isHost} onRole={(targetClientId, role) => send('role-set', { targetClientId, role })} />
          <UserGroup title="Viewers" users={users.filter((user) => !user.isHost && user.role === 'viewer')} clientId={clientId} isHost={isHost} onRole={(targetClientId, role) => send('role-set', { targetClientId, role })} />
          <div className="role-controls"><span>Role controls {isHost ? '' : '(Host only)'}</span><button disabled={!isHost} onClick={copyInvite}><UserPlus size={18} />Invite users</button></div>
          <ChatDock chat={chat} chatText={chatText} setChatText={setChatText} sendChat={sendChat} />
        </section>
      </aside>
    </div>
  );
}

function UserGroup({ title, users, clientId, isHost, onRole }) {
  if (!users.length) return null;
  return (
    <section className="user-group">
      <h2>{title === 'Host' && <Crown size={16} />} {title}</h2>
      {users.map((user) => (
        <div className="user" key={user.clientId}>
          <span className="avatar" style={{ background: user.color }}>{getInitials(user.name)}</span>
          <div><b>{user.name}{user.clientId === clientId ? ' you' : ''}</b><small /></div>
          {isHost && !user.isHost ? (
            <select value={user.role} onChange={(event) => onRole(user.clientId, event.target.value)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          ) : (
            <span className={user.isHost ? 'host-badge' : 'role-badge'}>{user.isHost ? 'Host' : user.role}</span>
          )}
        </div>
      ))}
    </section>
  );
}

function InlineExplorerInput({ input, setInput, onSubmit, onCancel }) {
  return (
    <form className="explorer-inline-form" onSubmit={onSubmit} onClick={(event) => event.stopPropagation()}>
      <span className="file-token">{input.type === 'folder-create' ? 'DIR' : 'F'}</span>
      <input
        value={input.value}
        onChange={(event) => setInput({ ...input, value: event.target.value })}
        onBlur={onSubmit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />
    </form>
  );
}

function ChatMessages({ chat }) {
  const messages = chat;
  return (
    <div className="messages">
      {messages.map((message) => (
        <article className="message" key={message.id}>
          <span className="avatar small" style={{ background: message.color }}>{getInitials(message.name)}</span>
          <div><strong>{message.name}</strong><time>{shortTime(message.createdAt)}</time><p>{message.text}</p></div>
        </article>
      ))}
      {!messages.length && <div className="empty-chat"><b>No messages yet</b><span>Use chat to coordinate changes while editing.</span></div>}
    </div>
  );
}

function ChatForm({ chatText, setChatText, sendChat }) {
  return (
    <form onSubmit={sendChat}>
      <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Type a message..." />
      <button aria-label="Send message"><Send size={20} /></button>
    </form>
  );
}

function ChatDock(props) {
  return <section className="chat-dock"><ChatMessages chat={props.chat} /><ChatForm {...props} /></section>;
}

createRoot(document.getElementById('root')).render(<App />);
