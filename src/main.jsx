import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import './styles.css';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:3001`;
const COLORS = ['#4ec9b0', '#c586c0', '#dcdcaa', '#9cdcfe', '#ce9178', '#b5cea8', '#569cd6'];
const ICONS = {
  explorer: 'EX',
  users: 'US',
  chat: 'CH',
  settings: 'ST',
  run: 'RN',
  branch: 'BR',
  search: 'SR',
  share: 'SH',
  crown: 'HOST'
};

const EXTENSIONS = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  java: 'java',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  cs: 'csharp',
  html: 'html',
  css: 'css',
  json: 'json',
  md: 'markdown',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  go: 'go',
  php: 'php',
  rb: 'ruby',
  rs: 'rust',
  sql: 'sql',
  sh: 'shell'
};

function languageFor(file) {
  const ext = file?.name?.split('.').pop()?.toLowerCase();
  return EXTENSIONS[ext] || 'plaintext';
}

function getInitials(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
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
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function useLocalIdentity() {
  return useMemo(() => {
    const existing = localStorage.getItem('collab-code-identity');
    if (existing) return JSON.parse(existing);
    const identity = {
      clientId: nanoid(10),
      name: `Coder ${Math.floor(Math.random() * 900 + 100)}`,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    };
    localStorage.setItem('collab-code-identity', JSON.stringify(identity));
    return identity;
  }, []);
}

function App() {
  const identity = useLocalIdentity();
  const [name, setName] = useState(identity.name);
  const [entered, setEntered] = useState(Boolean(new URLSearchParams(location.search).get('room')));
  const [roomId, setRoomId] = useState(new URLSearchParams(location.search).get('room') || nanoid(8));
  const [status, setStatus] = useState('disconnected');
  const [clientId, setClientId] = useState(identity.clientId);
  const [hostClientId, setHostClientId] = useState(null);
  const [users, setUsers] = useState([]);
  const [files, setFiles] = useState([]);
  const [activeFileId, setActiveFileId] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState('');
  const [remoteCursors, setRemoteCursors] = useState(new Map());
  const socketRef = useRef(null);
  const docsRef = useRef(new Map());
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const modelRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const decorationsRef = useRef([]);

  const activeFile = files.find((file) => file.id === activeFileId);
  const me = users.find((user) => user.clientId === clientId);
  const isHost = hostClientId === clientId;
  const canEdit = me?.role === 'editor' || isHost;

  useEffect(() => {
    if (!entered) return undefined;

    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({
        type: 'join',
        roomId,
        clientId: identity.clientId,
        name,
        color: identity.color
      }));
      history.replaceState(null, '', `?room=${roomId}`);
    };

    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('error');
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'joined') {
        setClientId(message.clientId);
        setRoomId(message.roomId);
      }

      if (message.type === 'room-state') {
        setHostClientId(message.hostClientId);
        setUsers(message.users);
        setFiles(message.files);
        setChat(message.chat);
        setActiveFileId((current) => current || message.files[0]?.id || null);
        setOpenTabs((tabs) => tabs.length ? tabs : message.files.slice(0, 1).map((file) => file.id));
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
        setRemoteCursors((next) => {
          const copy = new Map(next);
          copy.set(message.clientId, message);
          return copy;
        });
      }

      if (message.type === 'cursor-clear') {
        setRemoteCursors((next) => {
          const copy = new Map(next);
          copy.delete(message.clientId);
          return copy;
        });
      }
    };

    return () => ws.close();
  }, [entered]);

  useEffect(() => {
    localStorage.setItem('collab-code-identity', JSON.stringify({ ...identity, name }));
  }, [name]);

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

  function getDoc(fileId) {
    if (!docsRef.current.has(fileId)) {
      const doc = new Y.Doc();
      doc.getText('content').observe(() => {
        if (activeFileId === fileId) syncTextToModel(fileId);
      });
      doc.on('update', (update) => {
        if (applyingRemoteRef.current || !canEdit) return;
        const ws = socketRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'y-update',
            fileId,
            update: uint8ToBase64(update)
          }));
        }
      });
      docsRef.current.set(fileId, doc);
    }
    return docsRef.current.get(fileId);
  }

  function syncTextToModel(fileId) {
    const model = modelRef.current;
    if (!model || fileId !== activeFileId) return;
    const text = getDoc(fileId).getText('content').toString();
    if (model.getValue() === text) return;
    const position = editorRef.current?.getPosition();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    if (position) editorRef.current?.setPosition(position);
  }

  function handleEditorMount(editor, monaco) {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidChangeCursorSelection((event) => {
      const ws = socketRef.current;
      if (!activeFileId || ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'cursor',
        fileId: activeFileId,
        position: event.position,
        selection: event.selection
      }));
    });
  }

  function handleEditorChange(value) {
    if (!activeFileId || applyingRemoteRef.current || !canEdit) return;
    const ytext = getDoc(activeFileId).getText('content');
    if (ytext.toString() === value) return;
    applyingRemoteRef.current = false;
    ytext.delete(0, ytext.length);
    ytext.insert(0, value || '');
  }

  function handleModelReady(editor) {
    modelRef.current = editor.getModel();
    if (activeFileId) syncTextToModel(activeFileId);
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
          after: {
            content: user.name,
            inlineClassName: 'remote-cursor-label'
          }
        }
      });
      if (cursor.selection) {
        decorations.push({
          range: new monaco.Range(
            cursor.selection.startLineNumber,
            cursor.selection.startColumn,
            cursor.selection.endLineNumber,
            cursor.selection.endColumn
          ),
          options: { className: 'remote-selection' }
        });
      }
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
  }

  function send(type, payload = {}) {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  function createFile() {
    const name = prompt('File name', 'main.js');
    if (name) send('file-create', { name });
  }

  function renameFile(file) {
    const name = prompt('Rename file', file.name);
    if (name) send('file-rename', { fileId: file.id, name });
  }

  function deleteFile(file) {
    if (confirm(`Delete ${file.name}?`)) send('file-delete', { fileId: file.id });
  }

  function sendChat(event) {
    event.preventDefault();
    send('chat', { text: chatText });
    setChatText('');
  }

  if (!entered) {
    return (
      <main className="join-screen">
        <div className="join-backdrop" />
        <section className="join-panel">
          <div className="join-brand">
            <span className="brand-mark">CC</span>
            <div>
              <p className="eyebrow">Free collaborative coding workspace</p>
              <h1>Collab Code IDE</h1>
            </div>
          </div>
          <p className="join-copy">Open a shared coding room with live files, cursors, host permissions, and chat.</p>
          <label>
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Room ID
            <input value={roomId} onChange={(event) => setRoomId(event.target.value)} />
          </label>
          <button onClick={() => setEntered(true)}>Join workspace</button>
          <div className="join-meta">
            <span>Monaco</span>
            <span>Yjs</span>
            <span>WebSocket</span>
            <span>Session-only</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="window-controls"><span /><span /><span /></div>
        <strong className="app-title">Collab Code IDE</strong>
        <div className="command-center">
          <span>{roomId}</span>
          <small>{users.length} {users.length === 1 ? 'person' : 'people'}</small>
        </div>
        <span className={`status ${status}`}>{status}</span>
        <button className="share-button" onClick={() => navigator.clipboard?.writeText(location.href)}>{ICONS.share} Share</button>
        <span className="room">Room {roomId}</span>
      </header>

      <nav className="activitybar">
        <button className="active" title="Explorer">{ICONS.explorer}</button>
        <button title="Search">{ICONS.search}</button>
        <button title="Source control">{ICONS.branch}</button>
        <button title="Run">{ICONS.run}</button>
        <button title="Settings">{ICONS.settings}</button>
      </nav>

      <aside className="explorer">
        <div className="panel-head">
          <span>Explorer</span>
          <button disabled={!canEdit} onClick={createFile} title="New file">+</button>
        </div>
        <div className="workspace-name">PROJECT-{roomId.toUpperCase()}</div>
        <div className="file-list">
          {files.map((file) => (
            <button
              key={file.id}
              className={file.id === activeFileId ? 'file active' : 'file'}
              onClick={() => setActiveFileId(file.id)}
            >
              <span className="file-main"><b>{languageFor(file).slice(0, 2).toUpperCase()}</b>{file.name}</span>
              {canEdit && (
                <span className="file-actions">
                  <i onClick={(event) => { event.stopPropagation(); renameFile(file); }} title="Rename">rename</i>
                  <i onClick={(event) => { event.stopPropagation(); deleteFile(file); }} title="Delete">delete</i>
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <nav className="tabs">
          {openTabs.map((tabId) => {
            const file = files.find((item) => item.id === tabId);
            if (!file) return null;
            return (
              <button key={tabId} className={tabId === activeFileId ? 'tab active' : 'tab'} onClick={() => setActiveFileId(tabId)}>
                {file.name}
              </button>
            );
          })}
        </nav>
        <Editor
          key={activeFileId}
          height="100%"
          theme="vs-dark"
          language={languageFor(activeFile)}
          options={{
            readOnly: !canEdit,
            fontSize: 14,
            minimap: { enabled: true },
            automaticLayout: true,
            formatOnPaste: true,
            formatOnType: true,
            tabSize: 2,
            insertSpaces: true,
            wordWrap: 'on'
          }}
          onMount={(editor, monaco) => {
            handleEditorMount(editor, monaco);
            handleModelReady(editor);
          }}
          onChange={handleEditorChange}
        />
        <footer className="statusbar">
          <span>{ICONS.branch} main</span>
          <span>{canEdit ? 'Editable' : 'Read-only'}</span>
          <span>{activeFile?.name || 'No file'}</span>
          <span>{languageFor(activeFile)}</span>
          <span>Spaces: 2</span>
          <span>Live Share: On</span>
        </footer>
      </main>

      <aside className="sidepanel">
        <section className="collab-summary">
          <div>
            <span className="section-kicker">Collaboration</span>
            <h2>Live Room</h2>
          </div>
          <span className={isHost ? 'host-pill active' : 'host-pill'}>{isHost ? 'HOST' : me?.role || 'viewer'}</span>
          <div className="room-metrics">
            <span><b>{users.length}</b> online</span>
            <span><b>{files.length}</b> files</span>
            <span><b>{canEdit ? 'On' : 'Off'}</b> edit</span>
          </div>
        </section>

        <section className="users">
          <div className="panel-head">
            <span>{ICONS.users} People</span>
            <small>{isHost ? 'Role control enabled' : 'Host controls roles'}</small>
          </div>
          <div className="user-list">
            {users.map((user) => (
              <div className={user.isHost ? 'user host-user' : 'user'} key={user.clientId}>
                <span className="avatar" style={{ background: user.color }}>{getInitials(user.name)}</span>
                <span className="user-copy">
                  <b>{user.name}{user.clientId === clientId ? ' you' : ''}</b>
                  <small>{user.isHost ? `${ICONS.crown}` : user.role}</small>
                </span>
                {isHost && !user.isHost ? (
                  <select value={user.role} onChange={(event) => send('role-set', { targetClientId: user.clientId, role: event.target.value })}>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                ) : (
                  <span className="role-badge">{user.isHost ? 'host' : user.role}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="chat">
          <div className="panel-head">
            <span>{ICONS.chat} Chat</span>
            <small>{chat.length} messages</small>
          </div>
          <div className="messages">
            {chat.map((message) => (
              <article className="message" key={message.id}>
                <span className="avatar small" style={{ background: message.color }}>{getInitials(message.name)}</span>
                <div>
                  <strong style={{ color: message.color }}>{message.name}</strong>
                  <span>{shortTime(message.createdAt)}</span>
                  <p>{message.text}</p>
                </div>
              </article>
            ))}
            {!chat.length && (
              <div className="empty-chat">
                <b>No messages yet</b>
                <span>Use chat to discuss edits while everyone works in the same files.</span>
              </div>
            )}
          </div>
          <form onSubmit={sendChat}>
            <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Discuss changes..." />
            <button>Send</button>
          </form>
        </section>
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
