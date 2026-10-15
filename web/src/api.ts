// HTTP API calls. Each carries the signed-in player's link credential, or a guest's table key.
import type { PlayerInfo, RoomSummary } from '../../shared/protocol.ts';
import type { Op } from '../../shared/model.ts';
import type { JoinInfo } from './chime-av';

export interface JoinResponse extends JoinInfo {
  token: string;
  wsUrl: string;
  /** Your name as the server cleaned it (used as your seat). */
  name: string;
  room: { id: string; name: string; system: string };
}

/** Who's calling: a player (their link credential) or a guest (the table key). */
export type Auth = { player: string } | { key: string };

/** Players as admins see them: with the link to send them. */
export type PlayerRow = PlayerInfo & { link?: string };

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

export const listRooms = (auth: Auth) => post<{ rooms: RoomSummary[] }>('/api/rooms', auth);

export const createRoom = (auth: Auth, name: string, system: string, setup: Op[]) =>
  post<{ room: RoomSummary }>('/api/rooms/create', { ...auth, name, system, setup });

export const archiveRoom = (auth: Auth, room: string, archived: boolean) =>
  post<{ ok: true }>('/api/rooms/archive', { ...auth, room, archived });

/** `name` is only used for guests; players join as themselves. */
export const joinRoom = (auth: Auth, room: string, name?: string) =>
  post<JoinResponse>('/api/join', { ...auth, room, name });

// ---- Players --------------------------------------------------------------------------------

/** A credential ("<id>.<secret>") as a sign-in link on this site. */
export const playerLink = (credential: string) => `${location.origin}/?p=${credential}`;

export const whoAmI = (auth: Auth) => post<{ player?: PlayerInfo; guest?: true; setUp?: boolean }>('/api/players/me', auth);

/** First-time setup with the table key: makes you the first admin. Returns your credential. */
export const setUpPlayers = (key: string, name: string) => post<{ player: PlayerInfo; link: string }>('/api/players/setup', { key, name });

export const listPlayers = (auth: Auth) => post<{ players: PlayerRow[] }>('/api/players/list', auth);

export const addPlayer = (auth: Auth, name: string, roles: { admin: boolean; gm: boolean }) =>
  post<{ player: PlayerInfo; link: string }>('/api/players/add', { ...auth, name, ...roles });

export const updatePlayer = (auth: Auth, id: string, set: { admin?: boolean; gm?: boolean; color?: string; portrait?: string }) =>
  post<{ player: PlayerInfo }>('/api/players/update', { ...auth, id, ...set });

export const resetLink = (auth: Auth, id: string) => post<{ link: string }>('/api/players/reset-link', { ...auth, id });

export const removePlayer = (auth: Auth, id: string) => post<{ ok: true }>('/api/players/remove', { ...auth, id });

export interface LobbyInfo {
  room: { id: string; name: string; system: string };
  gm: string | null;
  background: { src: string; name: string } | null;
  music: { src: string; name: string } | null;
  /** Connected to the room now. */
  here: string[];
  /** Others on this lobby screen (not you). */
  waiting: string[];
}

/** A room's pre-join screen; also marks you as waiting there (or, with `leave`, not). */
export const lobbyInfo = (auth: Auth, room: string, name?: string, leave = false) =>
  post<LobbyInfo>('/api/rooms/lobby', { ...auth, room, name, leave });
