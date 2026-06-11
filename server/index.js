import express from 'express';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';

const PORT = process.env.PORT || 3001;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static('dist'));

const rooms = new Map();

const starterFiles = [
  {
    id: 'file-welcome',
    type: 'file',
    name: 'welcome.js',
    path: '/welcome.js',
    content: `function hello(name) {\n  console.log(\`Welcome, \${name}!\`);\n}\n\nhello('collaborators');\n`
  },
  {
    id: 'file-notes',
    type: 'file',
    name: 'notes.md',
    path: '/notes.md',
    content: '# Shared notes\n\nUse the file explorer to add files and collaborate.\n'
  }
];

function createRoom(roomId) {
  const room = {
    id: roomId,
    hostClientId: null,
    clients: new Map(),
    chat: [],
    files: starterFiles.map(({ content, ...file }) => file),
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
    files: room.files,
    chat: room.chat.slice(-100)
  });
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

function uniquePath(room, name) {
  let candidate = name.startsWith('/') ? name : `/${name}`;
  let suffix = 1;
  const paths = new Set(room.files.map((file) => file.path));
  while (paths.has(candidate)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > -1 ? name.slice(0, dot) : name;
    const ext = dot > -1 ? name.slice(dot) : '';
    candidate = `/${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  return candidate;
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

    if (message.type === 'file-create') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const name = String(message.name || 'untitled.txt').replace(/[\\/]/g, '').slice(0, 80) || 'untitled.txt';
      const path = uniquePath(joinedRoom, name);
      const file = { id: nanoid(10), type: 'file', name, path };
      joinedRoom.files.push(file);
      joinedRoom.docs.set(file.id, new Y.Doc());
      syncRoom(joinedRoom);
      return;
    }

    if (message.type === 'file-rename') {
      if (!canEdit(joinedRoom, clientId)) return send(ws, { type: 'permission-denied', reason: 'viewer' });
      const file = joinedRoom.files.find((item) => item.id === message.fileId);
      if (!file) return;
      const name = String(message.name || file.name).replace(/[\\/]/g, '').slice(0, 80) || file.name;
      file.name = name;
      file.path = uniquePath(joinedRoom, name);
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
