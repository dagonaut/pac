// HTTP API. Each call carries a player's link credential ({ player: "<id>.<secret>" }) or, for
// guests, the shared table key ({ key }); shown as AUTH below.
//   POST /api/rooms        { AUTH }                        -> { rooms }
//   POST /api/rooms/create { AUTH, name, system, setup }   -> { room }
//   POST /api/rooms/archive { AUTH, room, archived }       -> { ok }
//   POST /api/join         { AUTH, room, name? }           -> { meeting, attendee, token, wsUrl, name, room }
//   POST /api/players/<action>                             -> see players.ts
// and, gated by the session token from /api/join instead (or a player credential, for portraits):
//   POST /api/assets       { token, files: [{name, type, size}] } -> { uploads: [{url, fields, path}] }
//   POST /api/assets       { player, purpose: 'portrait', files: [one] }
import {
  ChimeSDKMeetingsClient,
  CreateAttendeeCommand,
  CreateMeetingCommand,
  DeleteMeetingCommand,
  GetMeetingCommand,
  type Meeting,
} from '@aws-sdk/client-chime-sdk-meetings';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomInt, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { apply, OpError, resolve } from '../../shared/engine.ts';
import { emptyRoom, type Op } from '../../shared/model.ts';
import type { RoomSummary } from '../../shared/protocol.ts';
import {
  cleanName, ddb, GAME_TABLE, json, loadState, signSession, STATE_SK, stateItem, verifySession,
} from './common.ts';
import { AuthError, authenticate, type Caller, guestNameAllowed, playerFrom, playersRoute } from './players.ts';

// Chime's meeting API lives in a "control" region; the media itself runs in MEDIA_REGION.
const chime = new ChimeSDKMeetingsClient({ region: process.env.CHIME_CONTROL_REGION });
const MEETINGS_TABLE = process.env.ROOMS_TABLE!;
const MEDIA_REGION = process.env.CHIME_MEDIA_REGION!;
const WS_URL = process.env.WS_URL!;
const SESSION_HOURS = 12;
const ASSETS_BUCKET = process.env.ASSETS_BUCKET!;
const s3 = new S3Client({});

// Raster images only: SVG can carry scripts and assets are served from our own origin.
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;

// Same shape as AuthError, so both turn into an HTTP status the same way.
class HttpError extends AuthError {}

// ---- Chime meetings -------------------------------------------------------------------------

// Chime ends a meeting ~5 minutes after the last attendee leaves, so a stored id may be stale.
async function liveMeeting(meetingId: string): Promise<Meeting | undefined> {
  try {
    return (await chime.send(new GetMeetingCommand({ MeetingId: meetingId }))).Meeting;
  } catch (e) {
    if ((e as Error).name === 'NotFoundException') return undefined;
    throw e;
  }
}

async function meetingFor(room: string, attempt = 0): Promise<Meeting> {
  const existing = (await ddb.send(new GetCommand({ TableName: MEETINGS_TABLE, Key: { room } }))).Item;
  if (existing) {
    const live = await liveMeeting(existing.meetingId);
    if (live) return live;
  }

  const created = (
    await chime.send(
      new CreateMeetingCommand({ ClientRequestToken: randomUUID(), MediaRegion: MEDIA_REGION, ExternalMeetingId: room }),
    )
  ).Meeting!;

  try {
    // Only claim the room if nobody else replaced the (stale) meeting in the meantime.
    await ddb.send(
      new PutCommand({
        TableName: MEETINGS_TABLE,
        Item: { room, meetingId: created.MeetingId, createdAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(room) OR meetingId = :old',
        ExpressionAttributeValues: { ':old': existing?.meetingId ?? '-' },
      }),
    );
    return created;
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException) || attempt > 2) throw e;
    // Lost a race with another join: drop ours and use theirs.
    await chime.send(new DeleteMeetingCommand({ MeetingId: created.MeetingId }));
    return meetingFor(room, attempt + 1);
  }
}

// ---- Routes ---------------------------------------------------------------------------------

async function listRooms(): Promise<{ rooms: RoomSummary[] }> {
  const items = (
    await ddb.send(
      new ScanCommand({
        TableName: GAME_TABLE,
        FilterExpression: 'sk = :s',
        ExpressionAttributeValues: { ':s': STATE_SK },
        ProjectionExpression: 'pk, #n, #sys, updated, archived',
        ExpressionAttributeNames: { '#n': 'name', '#sys': 'system' },
      }),
    )
  ).Items ?? [];
  const rooms = items
    .map((i) => ({ id: String(i.pk).slice('room#'.length), name: i.name, system: i.system, updated: i.updated, archived: !!i.archived }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
  return { rooms };
}

const slug = (name: string) =>
  name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'room';

async function createRoom(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim().slice(0, 60);
  const system = String(body.system ?? '');
  const setup = (Array.isArray(body.setup) ? body.setup : []) as Op[];
  if (!name) throw new HttpError(400, 'Give the room a name.');
  if (!/^[a-z0-9-]{1,40}$/.test(system)) throw new HttpError(400, 'Pick a system.');
  if (setup.length > 200) throw new HttpError(400, 'Setup is too big.');

  for (let n = 1; n < 20; n++) {
    const id = n === 1 ? slug(name) : `${slug(name)}-${n}`;
    const state = emptyRoom(id, name, system);
    // The system's setup ops (zones, starting decks) arrive from the browser; the server just
    // applies them like any other ops, so it never needs to know the system.
    try {
      const rand = (sides: number) => randomInt(1, sides + 1);
      for (const op of setup) apply(state, resolve(state, op, { rand }));
    } catch (e) {
      if (e instanceof OpError) throw new HttpError(400, `Setup failed: ${e.message}`);
      throw e;
    }
    try {
      await ddb.send(
        new PutCommand({ TableName: GAME_TABLE, Item: stateItem(state), ConditionExpression: 'attribute_not_exists(pk)' }),
      );
      return { room: { id, name, system, updated: new Date().toISOString() } satisfies RoomSummary };
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
      // Name taken: try name-2, name-3...
    }
  }
  throw new HttpError(409, 'Could not find a free room id; try another name.');
}

/** Archiving only hides a room from the lobby; its state, log and art are untouched. */
async function archiveRoom(body: Record<string, unknown>) {
  const room = String(body.room ?? '');
  if (!/^[a-z0-9-]{1,40}$/.test(room)) throw new HttpError(400, 'Bad room.');
  try {
    await ddb.send(new UpdateCommand({
      TableName: GAME_TABLE,
      Key: { pk: `room#${room}`, sk: STATE_SK },
      UpdateExpression: 'SET archived = :a',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':a': body.archived !== false },
    }));
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new HttpError(404, 'No such room.');
    throw e;
  }
  return { ok: true };
}

async function join(body: Record<string, unknown>, caller: Caller) {
  const room = String(body.room ?? '').trim().toLowerCase();
  // Players are who their link says; guests type a name, which mustn't be a player's.
  const player = 'player' in caller ? caller.player : undefined;
  const name = player ? player.name : cleanName(body.name);
  if (!/^[a-z0-9-]{1,40}$/.test(room)) throw new HttpError(400, 'Room must be 1–40 letters, numbers or dashes.');
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (!player && !(await guestNameAllowed(name))) {
    throw new HttpError(409, `${name} is a player here. Players sign in with their own link; as a guest, pick another name.`);
  }
  const state = await loadState(room);
  if (!state) throw new HttpError(404, `There's no room "${room}". Create it from the room list.`);

  const meeting = await meetingFor(room);
  const attendee = (
    await chime.send(
      new CreateAttendeeCommand({
        MeetingId: meeting.MeetingId,
        // "<short id>#<display name>" so clients can show names without another lookup.
        ExternalUserId: `${randomUUID().slice(0, 8)}#${name}`,
      }),
    )
  ).Attendee;

  const token = await signSession({
    room, name, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600, ...(player ? { pid: player.id, gm: player.gm } : {}),
  });
  return {
    meeting,
    attendee,
    token,
    wsUrl: WS_URL,
    name,
    room: { id: room, name: state.name, system: state.system } satisfies Omit<RoomSummary, 'updated'>,
  };
}

/** Presigned S3 POSTs for card art. Files land under assets/<room>/ with random names. */
async function uploadUrls(body: Record<string, unknown>) {
  // A player's portrait goes under their own folder; everything else belongs to a room.
  let folder: string;
  let max = MAX_FILES;
  if (body.purpose === 'portrait') {
    const player = await playerFrom(body.player);
    if (!player) throw new HttpError(403, 'That player link is no longer valid.');
    folder = `players/${player.id}`;
    max = 1;
  } else {
    const claims = await verifySession(String(body.token ?? ''));
    if (!claims) throw new HttpError(401, 'Session expired. Rejoin the room.');
    folder = claims.room;
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length || files.length > max) throw new HttpError(400, `Upload 1–${max} images at a time.`);

  const uploads = await Promise.all(
    files.map(async (f: { name?: unknown; type?: unknown; size?: unknown }) => {
      const type = String(f.type ?? '');
      const ext = IMAGE_TYPES[type];
      if (!ext) throw new HttpError(400, `"${String(f.name)}" isn't a PNG, JPEG, WebP, GIF or AVIF image.`);
      if (Number(f.size) > MAX_IMAGE_BYTES) throw new HttpError(400, `"${String(f.name)}" is over 8 MB.`);
      const key = `assets/${folder}/${randomUUID()}.${ext}`;
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: ASSETS_BUCKET,
        Key: key,
        Conditions: [['content-length-range', 1, MAX_IMAGE_BYTES], ['eq', '$Content-Type', type]],
        Fields: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
        Expires: 600,
      });
      return { url, fields, path: `/${key}` };
    }),
  );
  return { uploads };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: Record<string, unknown>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
    body = JSON.parse(raw || '{}');
  } catch {
    return json(400, { error: 'Request body must be JSON.' });
  }

  try {
    if (event.routeKey === 'POST /api/assets') return json(200, await uploadUrls(body));
    if (event.routeKey.startsWith('POST /api/players/')) {
      return json(200, await playersRoute(event.routeKey.slice('POST /api/players/'.length), body));
    }
    const caller = await authenticate(body);
    switch (event.routeKey) {
      case 'POST /api/rooms': return json(200, await listRooms());
      case 'POST /api/rooms/create': return json(200, await createRoom(body));
      case 'POST /api/rooms/archive': return json(200, await archiveRoom(body));
      case 'POST /api/join': return json(200, await join(body, caller));
      default: return json(404, { error: 'Not found.' });
    }
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Server error.' });
  }
}
