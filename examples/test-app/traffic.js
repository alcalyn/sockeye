/**
 * Generates a mix of WebSocket traffic against the demo server, so the dashboard has
 * something to show: frequent small messages, heavy payloads, and slow requests.
 */
import { io } from 'socket.io-client';

const PORT = Number(process.env.PORT ?? 3000);
const CLIENTS = Number(process.env.CLIENTS ?? 3);

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const words = ['hello', 'ping', 'socket', 'monitor', 'metrics', 'latency', 'payload'];
const sentence = (length) =>
  Array.from({ length }, () => words[randomInt(0, words.length - 1)]).join(' ');

function startClient(index) {
  const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });

  socket.on('connect', () => console.log(`[traffic] client ${index} connected`));

  // Very frequent, tiny.
  setInterval(() => socket.emit('cursor:move', { x: randomInt(0, 1920), y: randomInt(0, 1080) }), 120);

  // Frequent, small, acknowledged.
  setInterval(() => {
    socket.emit('chat:send', { user: `user-${index}`, text: sentence(randomInt(3, 25)) }, () => {});
  }, 600);

  // Occasional, heavy.
  setInterval(() => {
    socket.emit('file:upload', { name: `capture-${randomInt(1, 99)}.bin`, chunk: 'x'.repeat(randomInt(50_000, 400_000)) }, () => {});
  }, 4000);

  // Rare, slow.
  setInterval(() => {
    socket.emit('report:generate', { from: '2024-01-01', to: '2024-12-31', scope: sentence(4) }, () => {});
  }, 5000);
}

for (let index = 1; index <= CLIENTS; index++) startClient(index);

console.log(`[traffic] ${CLIENTS} clients generating traffic against port ${PORT}`);
