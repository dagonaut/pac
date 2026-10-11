// HTTP API calls (all gated by the table key).
import type { RoomSummary } from '../../shared/protocol.ts';
import type { Op } from '../../shared/model.ts';
import type { JoinInfo } from './chime-av';

export interface JoinResponse extends JoinInfo {
  token: string;
  wsUrl: string;
  /** Your name as the server cleaned it (used as your seat). */
  name: string;
  room: { id: string; name: string; system: string };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export const listRooms = (key: string) => post<{ rooms: RoomSummary[] }>('/api/rooms', { key });

export const createRoom = (key: string, name: string, system: string, setup: Op[]) =>
  post<{ room: RoomSummary }>('/api/rooms/create', { key, name, system, setup });

export const joinRoom = (key: string, room: string, name: string) =>
  post<JoinResponse>('/api/join', { key, room, name });
