import express from 'express';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

const PORT = process.env.PORT || 3001;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.static('dist'));

app.get('*', (_req, res) => {
  res.sendFile('dist/index.html', { root: '.' });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const rooms = new Map();

const starterFiles = [
  {
    id: 'file-welcome',
    type: 'file',
    folder: 'src',
    name: 'welcome.js',
    path: '/src/welcome.js',
    content: `function hello(name) {\n  const msg = \`Welcome, \${name}!\`;\n  console.log(msg);\n}\n\nfunction add(a, b) {\n  return a + b;\n}\n\nconst user = {\n  id: 1,\n  name: 'Collaborator',\n  role: 'developer'\n};\n\nfor (let i = 0; i < 3; i++) {\n  hello(user.name);\n}\n\nconsole.log('2 + 3 =', add(2, 3));\n`
  },
  {
    id: 'file-app',
    type: 'file',
    folder: 'src',
    name: 'app.ts',
    path: '/src/app.ts',
    content: `type Role = 'host' | 'editor' | 'viewer';\n\nexport interface RoomUser {\n  id: string;\n  name: string;\n  role: Role;\n}\n\nexport function canWrite(user: RoomUser) {\n  return user.role === 'host' || user.role === 'editor';\n}\n`
  },
  {
    id: 'file-styles',
    type: 'file',
    folder: 'src',
    name: 'styles.css',
    path: '/src/styles.css',
    content: `:root {\n  color-scheme: dark;\n  font-family: Inter, system-ui, sans-serif;\n}\n`
  },
  {
    id: 'file-index',
    type: 'file',
    folder: 'src',
    name: 'index.html',
    path: '/src/index.html',
    content: `<!doctype html>\n<html>\n  <body>\n    <main id="app"></main>\n  </body>\n</html>\n`
  },
  {
    id: 'file-notes',
    type: 'file',
    folder: 'docs',
    name: 'notes.md',
    path: '/docs/notes.md',
    content: '# Shared notes\n\nUse this room to discuss architecture and implementation decisions.\n'
  },
  {
    id: 'file-api',
    type: 'file',
    folder: 'docs',
    name: 'api.md',
    path: '/docs/api.md',
    content: '# Room API\n\n- join\n- room-state\n- y-update\n- cursor\n- chat\n'
  },
  {
    id: 'file-settings',
    type: 'file',
    folder: 'config',
    name: 'settings.json',
    path: '/config/settings.json',
    content: '{\n  "editor.tabSize": 2,\n  "collaboration.presence": true\n}\n'
  },
  {
    id: 'file-env',
    type: 'file',
    folder: 'config',
    name: 'env.example',
    path: '/config/env.example',
    content: 'PORT=3001\n'
  }
];

const starterFolders = ['src', 'docs', 'config'];

function createRoom(roomId) {
  const room = {
    id: roomId,
    hostClientId: null,
    clients: new Map(),
    chat: [],
    folders: [...starterFolders],
    files: starterFiles.map(({ content, ...file }) => ({ ...file })),
    docs: new Map(),
    cursors: new Map()
  };

  for (const file of starterFiles) {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, file.content);
    room.docs.set(file.id, doc);
  }

  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

function toBase64(update) {
  return Buffer.from(update).toString('base64');
}

function fromBase64(update) {
  return new Uint8Array(Buffer.from(update, 'base64'));
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, exceptClientId = null) {
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptClientId) {
      send(client.ws, payload);
    }
  }
}

function publicUsers(room) {
  return [...room.clients.entries()].map(([clientId, client]) => ({
    clientId,
    name: client.name,
    color: client.color,
    role: client.role,
    isHost: room.hostClientId === clientId
  }));
}

function syncRoom(room) {
  broadcast(room, {
    type: 'room-state',
    hostClientId: room.hostClientId,
    users: publicUsers(room),
    folders: room.folders,
    files: room.files,
    chat: room.chat.slice(-100)
  });
}

function roomFileContents(room) {
  return room.files.map((file) => ({
    ...file,
    content: ensureFileDoc(room, file.id).getText('content').toString()
  }));
}

function canEdit(room, clientId) {
  const client = room.clients.get(clientId);
  return client && (client.role === 'editor' || room.hostClientId === clientId);
}

function ensureFileDoc(room, fileId) {
  if (!room.docs.has(fileId)) {
    room.docs.set(fileId, new Y.Doc());
  }
  return room.docs.get(fileId);
}

function uniquePath(room, folder, name, ignoreFileId = null) {
  const cleanFolder = folder || 'src';
  let candidate = `/${cleanFolder}/${name}`;
  let suffix = 1;
  const paths = new Set(room.files.filter((file) => file.id !== ignoreFileId).map((file) => file.path));
  while (paths.has(candidate)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > -1 ? name.slice(0, dot) : name;
    const ext = dot > -1 ? name.slice(dot) : '';
    candidate = `/${cleanFolder}/${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  return candidate;
}

function cleanFolderName(name) {
  return String(name || 'new-folder')
    .replace(/[\\/]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'new-folder';
}

wss.on('connection', (ws) => {
  let joinedRoom = null;
  let clientId = nanoid(10);

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid message.' });
      return;
    }

    if (message.type === 'join') {
      const room = getRoom(message.roomId || nanoid(8));
      const color = message.color || `hsl(${Math.floor(Math.random() * 360)} 72% 58%)`;
      const name = String(message.name || 'Guest').slice(0, 32);
      const isFirst = room.clients.size === 0;
      clientId = message.clientId || clientId;
      joinedRoom = room;
      room.hostClientId ||= clientId;
      room.clients.set(clientId, {
        ws,
        name,
        color,
        role: isFirst || room.hostClientId === clientId ? 'editor' : 'viewer'
      });
      send(ws, {
        type: 'joined',
        clientId,
        roomId: room.id,
        isHost: room.hostClientId === clientId
      });
      syncRoom(room);
      return;
    }

    if (!joinedRoom || !joinedRoom.clients.has(clientId)) {
      send(ws, { type: 'error', message: 'Join a room first.' });
      return;
    }

    if (message.type === 'request-file') {
      const doc = ensureFileDoc(joinedRoom, message.fileId);
      send(ws, {
        type: 'file-sync',
        fileId: message.fileId,
        update: toBase64(Y.encodeStateAsUpdate(doc))
      });
      return;
    }

    if (message.type === 'y-update') {
      if (!canEdit(joinedRoom, clientId)) {
        send(ws, { type: 'permission-denied', reason: 'viewer' });
        return;
      }
      const doc = ensureFileDoc(joinedRoom, message.fileId);
      Y.applyUpdate(doc, fromBase64(message.update));
      broadcast(joinedRoom, {
        type: 'y-update',
        fileId: message.fileId,
        update: message.update,
        sourceClientId: clientId
      }, clientId);
      return;
    }

    if (message.type === 'cursor') {
      joinedRoom.cursors.set(clientId, {
        clientId,
        fileId: message.fileId,
        position: message.position,
        selection: message.selection
      });
      broadcast(joinedRoom, {
        type: 'cursor',
        clientId,
        fileId: message.fileId,
        position: message.position,
        selection: message.selection
      }, clientId);
      return;
    }

    if (message.type === 'chat') {
      const client = joinedRoom.clients.get(clientId);
      const entry = {
        id: nanoid(10),
        clientId,
        name: client.name,
        color: client.color,
        text: String(message.text || '').slice(0, 1000),
        createdAt: Date.now()
      };
      if (!entry.text.trim()) return;
      joinedRoom.chat.push(entry);
      joinedRoom.chat = joinedRoom.chat.slice(-100);
      broadcast(joinedRoom, { type: 'chat', message: entry });
      return;
    }

    if (message.type === 'name-update') {
      const client = joinedRoom.clients.get(clientId);
      if (!client) return;
      client.name = String(message.name || client.name).slice(0, 32) || client.name;
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'workspace-export') {
      send(ws, {
        type: 'workspace-export',
        requestId: message.requestId,
        roomId: joinedRoom.id,
        folders: joinedRoom.folders,
        files: roomFileContents(joinedRoom)
      });
      return;
    }

    if (message.type === 'file-create') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const name = String(message.name || 'untitled.txt').replace(/[\\/]/g, '').slice(0, 80) || 'untitled.txt';
      const folder = cleanFolderName(message.folder || joinedRoom.folders[0] || 'src');
      if (!joinedRoom.folders.includes(folder)) joinedRoom.folders.push(folder);
      const path = uniquePath(joinedRoom, folder, name);
      const file = { id: nanoid(10), type: 'file', folder, name, path };
      joinedRoom.files.push(file);
      joinedRoom.docs.set(file.id, new Y.Doc());
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'folder-create') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const baseName = cleanFolderName(message.name);
      let name = baseName;
      let suffix = 1;
      while (joinedRoom.folders.includes(name)) {
        name = `${baseName}-${suffix}`;
        suffix += 1;
      }
      joinedRoom.folders.push(name);
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'file-rename') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const file = joinedRoom.files.find((item) => item.id === message.fileId);
      if (!file) return;
      const name = String(message.name || file.name).replace(/[\\/]/g, '').slice(0, 80) || file.name;
      file.name = name;
      file.path = uniquePath(joinedRoom, file.folder, name, file.id);
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'file-move') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const file = joinedRoom.files.find((item) => item.id === message.fileId);
      if (!file) return;
      const folder = cleanFolderName(message.folder || file.folder || 'src');
      if (file.folder === folder) return;
      if (!joinedRoom.folders.includes(folder)) joinedRoom.folders.push(folder);
      file.folder = folder;
      file.path = uniquePath(joinedRoom, folder, file.name, file.id);
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'file-delete') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      if (joinedRoom.files.length <= 1) return;
      joinedRoom.files = joinedRoom.files.filter((file) => file.id !== message.fileId);
      joinedRoom.docs.delete(message.fileId);
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'role-set') {
      if (joinedRoom.hostClientId !== clientId) return send(ws, { type: 'permission-denied', reason: 'host-only' });
      if (message.targetClientId === joinedRoom.hostClientId) return;
      const target = joinedRoom.clients.get(message.targetClientId);
      if (target) {
        target.role = message.role === 'editor' ? 'editor' : 'viewer';
        syncRoom(joinedRoom);
      }
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    joinedRoom.clients.delete(clientId);
    joinedRoom.cursors.delete(clientId);
    if (joinedRoom.hostClientId === clientId) {
      const nextHost = joinedRoom.clients.keys().next().value;
      joinedRoom.hostClientId = nextHost || null;
      if (nextHost) {
        joinedRoom.clients.get(nextHost).role = 'editor';
      }
    }
    if (joinedRoom.clients.size === 0) {
      rooms.delete(joinedRoom.id);
    } else {
      broadcast(joinedRoom, { type: 'cursor-clear', clientId });
      syncRoom(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Collab IDE server running on http://localhost:${PORT}`);
});
