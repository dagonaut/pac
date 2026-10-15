// Players: the group's members, each with a private sign-in link (no passwords). Stored in the
// Game table as pk "players", sk "player#<id>". Guests still get in with the table key and a typed
// name, but can't use a player's name or take the GM seat.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PLAYER_COLORS, type PlayerInfo } from '../../shared/protocol.ts';
import { cleanName, ddb, GAME_TABLE, keyMatches } from './common.ts';

const PK = 'players';
const skOf = (id: string) => `player#${id}`;

export interface PlayerRecord extends PlayerInfo {
  /** The random part of their link: <id>.<secret>. */
  secret: string;
  created: string;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const publicInfo = ({ id, name, color, portrait, admin, gm }: PlayerRecord): PlayerInfo =>
  ({ id, name, color, ...(portrait ? { portrait } : {}), admin, gm });

export async function allPlayers(): Promise<PlayerRecord[]> {
  const items = (await ddb.send(new QueryCommand({
    TableName: GAME_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': PK },
  }))).Items ?? [];
  return (items as unknown as PlayerRecord[]).sort((a, b) => a.created.localeCompare(b.created));
}

async function getPlayer(id: string): Promise<PlayerRecord | undefined> {
  if (!/^[a-z0-9]{1,16}$/.test(id)) return undefined;
  return (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: { pk: PK, sk: skOf(id) } }))).Item as PlayerRecord | undefined;
}

const credential = (p: PlayerRecord) => `${p.id}.${p.secret}`;
const newSecret = () => randomBytes(24).toString('base64url');

/** The player a link credential ("<id>.<secret>") belongs to, if it's still valid. */
export async function playerFrom(cred: unknown): Promise<PlayerRecord | undefined> {
  const [id, secret] = String(cred ?? '').split('.');
  if (!id || !secret) return undefined;
  const p = await getPlayer(id);
  if (!p) return undefined;
  const a = Buffer.from(secret);
  const b = Buffer.from(p.secret);
  return a.length === b.length && timingSafeEqual(a, b) ? p : undefined;
}

export type Caller = { player: PlayerRecord } | { guest: true };

/** Every API call carries a player credential or, for guests, the table key. */
export async function authenticate(body: Record<string, unknown>): Promise<Caller> {
  if (body.player) {
    const player = await playerFrom(body.player);
    if (!player) throw new AuthError(403, 'That player link is no longer valid. Ask an admin for a new one.');
    return { player };
  }
  if (await keyMatches(body.key)) return { guest: true };
  throw new AuthError(403, 'Wrong table key.');
}

function requireAdmin(caller: Caller): PlayerRecord {
  if (!('player' in caller) || !caller.player.admin) throw new AuthError(403, 'Only an admin can manage players.');
  return caller.player;
}

/** A guest may not use a player's name (that would let anyone act as them). */
export async function guestNameAllowed(name: string): Promise<boolean> {
  const n = name.toLowerCase();
  return !(await allPlayers()).some((p) => p.name.toLowerCase() === n);
}

async function create(name: string, flags: { admin: boolean; gm: boolean }, existing: PlayerRecord[]) {
  if (!name) throw new AuthError(400, 'Give the player a name.');
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new AuthError(409, `There's already a player called ${name}.`);
  if (existing.length >= 50) throw new AuthError(400, 'That is a lot of players. 50 is the limit.');
  const used = new Set(existing.map((p) => p.color));
  const p: PlayerRecord = {
    id: randomBytes(5).toString('hex'),
    name,
    color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[existing.length % PLAYER_COLORS.length],
    admin: flags.admin,
    gm: flags.gm,
    secret: newSecret(),
    created: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: { pk: PK, sk: skOf(p.id), ...p }, ConditionExpression: 'attribute_not_exists(pk)' }));
  return p;
}

// ---- Routes (POST /api/players/...) -----------------------------------------------------------

/** Routes return a player's credential ("<id>.<secret>"); the browser turns it into a link on its
 *  own origin (?p=<credential>). */
export async function playersRoute(action: string, body: Record<string, unknown>) {
  const link = credential;

  // First-time setup: whoever has the table key makes the first admin (themselves), once.
  if (action === 'setup') {
    if (!(await keyMatches(body.key))) throw new AuthError(403, 'Wrong table key.');
    const existing = await allPlayers();
    if (existing.some((p) => p.admin)) throw new AuthError(409, 'Players are already set up. Ask an admin for your link.');
    const p = await create(cleanName(body.name), { admin: true, gm: true }, existing);
    return { player: publicInfo(p), link: link(p) };
  }

  const caller = await authenticate(body);
  switch (action) {
    // Who am I (and, for guests, is there anyone to ask for a link yet)?
    case 'me': {
      if ('player' in caller) return { player: publicInfo(caller.player) };
      return { guest: true, setUp: (await allPlayers()).some((p) => p.admin) };
    }

    case 'list': {
      const players = await allPlayers();
      const admin = 'player' in caller && caller.player.admin;
      // Admins also get everyone's link, so they can re-send one without resetting it.
      return { players: players.map((p) => ({ ...publicInfo(p), ...(admin ? { link: link(p) } : {}) })) };
    }

    case 'add': {
      requireAdmin(caller);
      const p = await create(cleanName(body.name), { admin: body.admin === true, gm: body.gm === true }, await allPlayers());
      return { player: publicInfo(p), link: link(p) };
    }

    case 'update': {
      // Admins change roles; anyone changes their own color and portrait.
      const target = await getPlayer(String(body.id ?? ''));
      if (!target) throw new AuthError(404, 'No such player.');
      const self = 'player' in caller && caller.player.id === target.id;
      const set: Partial<PlayerRecord> = {};
      if (body.admin !== undefined || body.gm !== undefined) {
        const me = requireAdmin(caller);
        if (body.admin !== undefined) {
          if (me.id === target.id && body.admin !== true) throw new AuthError(400, "You can't remove your own admin role.");
          set.admin = body.admin === true;
        }
        if (body.gm !== undefined) set.gm = body.gm === true;
      }
      if (body.color !== undefined || body.portrait !== undefined) {
        if (!self) throw new AuthError(403, 'Players choose their own color and portrait.');
        if (body.color !== undefined) {
          if (typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) throw new AuthError(400, 'Bad color.');
          set.color = body.color;
        }
        if (body.portrait !== undefined) {
          const ok = body.portrait === '' || (typeof body.portrait === 'string' &&
            new RegExp(`^/assets/players/${target.id}/[\\w-]+\\.(png|jpg|webp|gif|avif)$`).test(body.portrait));
          if (!ok) throw new AuthError(400, 'A portrait must be an image you uploaded.');
          set.portrait = body.portrait as string;
        }
      }
      const keys = Object.keys(set);
      if (!keys.length) throw new AuthError(400, 'Nothing to change.');
      const removePortrait = set.portrait === '';
      const sets = keys.filter((k) => !(k === 'portrait' && removePortrait));
      await ddb.send(new UpdateCommand({
        TableName: GAME_TABLE,
        Key: { pk: PK, sk: skOf(target.id) },
        UpdateExpression: [
          sets.length ? `SET ${sets.map((k) => `#${k} = :${k}`).join(', ')}` : '',
          removePortrait ? 'REMOVE #portrait' : '',
        ].filter(Boolean).join(' '),
        ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
        ...(sets.length ? { ExpressionAttributeValues: Object.fromEntries(sets.map((k) => [`:${k}`, set[k as keyof PlayerRecord]])) } : {}),
      }));
      const updated = { ...target, ...set };
      if (removePortrait) delete updated.portrait;
      return { player: publicInfo(updated) };
    }

    case 'reset-link': {
      requireAdmin(caller);
      const target = await getPlayer(String(body.id ?? ''));
      if (!target) throw new AuthError(404, 'No such player.');
      target.secret = newSecret();
      await ddb.send(new UpdateCommand({
        TableName: GAME_TABLE,
        Key: { pk: PK, sk: skOf(target.id) },
        UpdateExpression: 'SET secret = :s',
        ExpressionAttributeValues: { ':s': target.secret },
      }));
      return { link: link(target) };
    }

    case 'remove': {
      const me = requireAdmin(caller);
      const id = String(body.id ?? '');
      if (id === me.id) throw new AuthError(400, "You can't remove yourself.");
      await ddb.send(new DeleteCommand({ TableName: GAME_TABLE, Key: { pk: PK, sk: skOf(id) } }));
      return { ok: true };
    }

    default:
      throw new AuthError(404, 'Not found.');
  }
}
