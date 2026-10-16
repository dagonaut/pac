// Game-state WebSocket. Every op is resolved and applied here against the stored room state,
// written with an optimistic seq check (retried on conflict), logged, then broadcast to everyone
// in the room. Clients apply the broadcast op with the same shared engine.
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomInt, randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { apply, forbidden, OpError, publicNames, resolve } from '../../shared/engine.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';
import {
  CHUNK_CHARS, type ClientMessage, NOTE_BODY_MAX, NOTE_LOCK_MS, NOTE_TITLE_MAX, type NoteChange, type NotePage, type ServerMessage,
} from '../../shared/protocol.ts';
import { connSk, ddb, GAME_TABLE, loadState, logSk, MAX_STATE_CHARS, roomPk, stateItem, verifySession } from './common.ts';

const CONN_TTL_HOURS = 3; // API Gateway closes WebSockets after 2 hours anyway
const LOG_IN_SNAPSHOT = 100;
const MAX_RETRIES = 5;

type WsEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string> };
const ok: APIGatewayProxyResultV2 = { statusCode: 200 };

let mgmt: ApiGatewayManagementApiClient | undefined;
function client(event: WsEvent) {
  const { domainName, stage } = event.requestContext;
  mgmt ??= new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  return mgmt;
}

/** Split a message into frames that fit API Gateway's 128 KB limit. */
function frames(msg: ServerMessage): string[] {
  const json = JSON.stringify(msg);
  if (json.length <= CHUNK_CHARS) return [json];
  const id = randomUUID();
  const n = Math.ceil(json.length / CHUNK_CHARS);
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: 'chunk', id, i, n, data: json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) } satisfies ServerMessage));
}

async function send(event: WsEvent, connectionId: string, msg: ServerMessage): Promise<boolean> {
  try {
    for (const data of frames(msg)) {
      await client(event).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
    }
    return true;
  } catch (e) {
    if (e instanceof GoneException) return false;
    throw e;
  }
}

async function dropConnection(connectionId: string, room?: string) {
  if (!room) {
    const item = (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: { pk: `conn#${connectionId}`, sk: 'conn' } })))
      .Item;
    room = item?.room;
  }
  await ddb.send(new DeleteCommand({ TableName: GAME_TABLE, Key: { pk: `conn#${connectionId}`, sk: 'conn' } }));
  if (room) await ddb.send(new DeleteCommand({ TableName: GAME_TABLE, Key: { pk: roomPk(room), sk: connSk(connectionId) } }));
}

async function broadcast(event: WsEvent, room: string, msg: ServerMessage) {
  const conns = (
    await ddb.send(
      new QueryCommand({
        TableName: GAME_TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :c)',
        ExpressionAttributeValues: { ':pk': roomPk(room), ':c': 'conn#' },
      }),
    )
  ).Items ?? [];
  await Promise.all(
    conns.map(async (c) => {
      const id = String(c.sk).slice('conn#'.length);
      if (!(await send(event, id, msg))) await dropConnection(id, room);
    }),
  );
}

async function recentLog(room: string, limit: number) {
  return (
    (
      await ddb.send(
        new QueryCommand({
          TableName: GAME_TABLE,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :l)',
          ExpressionAttributeValues: { ':pk': roomPk(room), ':l': 'log#' },
          ScanIndexForward: false,
          Limit: limit,
        }),
      )
    ).Items ?? []
  );
}

const toEntry = (item: Record<string, unknown>): LogEntry => ({
  seq: item.seq as number,
  by: item.by as string,
  ts: item.ts as string,
  op: JSON.parse(item.op as string),
  cid: item.cid as string | undefined,
  names: item.names as Record<string, string> | undefined,
});

/** Your most recent undoable, not-yet-undone action. */
async function findUndo(room: string, name: string): Promise<{ target: number; op: Op }> {
  const item = (await recentLog(room, 50)).find((i) => i.by === name && i.inverse && !i.undone);
  if (!item) throw new OpError('Nothing of yours to undo.');
  return { target: item.seq as number, op: JSON.parse(item.inverse as string) };
}

/** Resolve + apply + store one op, retrying if someone else's op landed first. */
async function commit(room: string, name: string, canGm: boolean, op: Op, cid: string): Promise<LogEntry> {
  const rand = (sides: number) => randomInt(1, sides + 1);
  for (let attempt = 0; ; attempt++) {
    const current = await loadState(room);
    if (!current) throw new OpError('This room no longer exists.');
    const no = forbidden(current, op, name, canGm);
    if (no) throw new OpError(no);
    const undo = op.kind === 'undo' ? await findUndo(room, name) : undefined;

    const next: RoomState = structuredClone(current);
    let resolved: Op;
    let inverse: Op | null;
    try {
      resolved = resolve(next, op, { rand, undo: undo && (() => undo) });
      inverse = apply(next, resolved);
    } catch (e) {
      // An undo whose reversal no longer fits the table (e.g. its zone was deleted) would block
      // every later undo. Mark it done so the next Undo reaches the action before it.
      if (undo && e instanceof OpError) {
        await ddb.send(new UpdateCommand({
          TableName: GAME_TABLE,
          Key: { pk: roomPk(room), sk: logSk(undo.target) },
          UpdateExpression: 'SET undone = :t',
          ExpressionAttributeValues: { ':t': true },
        }));
        throw new OpError(`Your last action can't be undone anymore (${e.message}). Undo again for the one before it.`);
      }
      throw e;
    }
    next.seq = current.seq + 1;
    const item = stateItem(next);
    if (item.data.length > MAX_STATE_CHARS) {
      throw new OpError('This room is full. Clear some drawings or delete unused cards first.');
    }

    const entry: LogEntry = { seq: next.seq, by: name, ts: new Date().toISOString(), op: resolved, cid, names: publicNames(next, resolved) };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: GAME_TABLE,
                Item: item,
                ConditionExpression: 'seq = :seq',
                ExpressionAttributeValues: { ':seq': current.seq },
              },
            },
            {
              Put: {
                TableName: GAME_TABLE,
                Item: {
                  pk: roomPk(room),
                  sk: logSk(entry.seq),
                  ...entry,
                  op: JSON.stringify(resolved),
                  inverse: inverse ? JSON.stringify(inverse) : undefined,
                  names: entry.names,
                },
              },
            },
            ...(undo
              ? [{
                  Update: {
                    TableName: GAME_TABLE,
                    Key: { pk: roomPk(room), sk: logSk(undo.target) },
                    UpdateExpression: 'SET undone = :t',
                    ConditionExpression: 'attribute_not_exists(undone)',
                    ExpressionAttributeValues: { ':t': true },
                  },
                }]
              : []),
          ],
        }),
      );
      return entry;
    } catch (e) {
      if (!(e instanceof TransactionCanceledException) || attempt >= MAX_RETRIES) throw e;
    }
  }
}

// ---- Campaign notes ---------------------------------------------------------------------------
// Pages live beside the room state (room#<id> / note#<page>), not in it: notes grow every session
// and the state item is capped. Whoever is typing holds a short lock that their saves renew.

const noteSk = (id: string) => `note#${id}`;
const toPage = ({ pk: _pk, sk: _sk, ...page }: Record<string, unknown>) => page as unknown as NotePage;

async function allNotes(room: string): Promise<NotePage[]> {
  const pages: NotePage[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: GAME_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :n)',
      ExpressionAttributeValues: { ':pk': roomPk(room), ':n': 'note#' },
      ExclusiveStartKey: start,
    }));
    pages.push(...(r.Items ?? []).map(toPage));
    start = r.LastEvaluatedKey;
  } while (start);
  return pages;
}

/** Only while nobody else holds the page's lock (or theirs has run out). */
const FREE = 'attribute_not_exists(editor) OR editor = :me OR editorUntil < :now';

async function saveNote(room: string, name: string, change: NoteChange, lock: boolean): Promise<NotePage> {
  if (!change || typeof change !== 'object' || typeof change.id !== 'string' || !/^[\w-]{1,40}$/.test(change.id)) throw new OpError('Bad page.');
  const { title, body, deleted } = change;
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > NOTE_TITLE_MAX)) throw new OpError(`Page titles are 1–${NOTE_TITLE_MAX} characters.`);
  if (body !== undefined && (typeof body !== 'string' || body.length > NOTE_BODY_MAX)) throw new OpError(`A page holds at most ${NOTE_BODY_MAX.toLocaleString()} characters. Start a new page.`);
  if (deleted !== undefined && typeof deleted !== 'boolean') throw new OpError('Bad page.');
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const key = { pk: roomPk(room), sk: noteSk(change.id) };
  const existing = (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: key }))).Item;

  if (!existing) {
    if (!title) throw new OpError('A new page needs a title.');
    const page: NotePage = {
      id: change.id, title: title.trim(), body: body ?? '', created: iso, createdBy: name, updated: iso, updatedBy: name,
      ...(lock ? { editor: name, editorUntil: now + NOTE_LOCK_MS } : {}),
    };
    await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: { ...key, ...page }, ConditionExpression: 'attribute_not_exists(sk)' }));
    return page;
  }

  const set: Record<string, unknown> = {};
  if (title !== undefined) set.title = title.trim();
  if (body !== undefined) set.body = body;
  if (title !== undefined || body !== undefined) Object.assign(set, { updated: iso, updatedBy: name });
  if (deleted !== undefined) set.deleted = deleted;
  if (lock) Object.assign(set, { editor: name, editorUntil: now + NOTE_LOCK_MS });
  const keys = Object.keys(set);
  if (!keys.length) return toPage(existing);
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: GAME_TABLE,
      Key: key,
      UpdateExpression: `SET ${keys.map((k) => `#${k} = :${k}`).join(', ')}`,
      ConditionExpression: FREE,
      ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
      ExpressionAttributeValues: { ...Object.fromEntries(keys.map((k) => [`:${k}`, set[k]])), ':me': name, ':now': now },
      ReturnValues: 'ALL_NEW',
    }));
    return toPage(r.Attributes!);
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new OpError(`${String(existing.editor)} is editing this page right now.`);
    throw e;
  }
}

async function lockNote(room: string, name: string, id: string, lock: boolean): Promise<NotePage> {
  if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new OpError('Bad page.');
  const key = { pk: roomPk(room), sk: noteSk(id) };
  try {
    const r = await ddb.send(new UpdateCommand(lock
      ? {
          TableName: GAME_TABLE, Key: key,
          UpdateExpression: 'SET editor = :me, editorUntil = :until',
          ConditionExpression: `attribute_exists(sk) AND (${FREE})`,
          ExpressionAttributeValues: { ':me': name, ':now': Date.now(), ':until': Date.now() + NOTE_LOCK_MS },
          ReturnValues: 'ALL_NEW',
        }
      : {
          TableName: GAME_TABLE, Key: key,
          UpdateExpression: 'REMOVE editor, editorUntil',
          ConditionExpression: 'editor = :me',
          ExpressionAttributeValues: { ':me': name },
          ReturnValues: 'ALL_NEW',
        }));
    return toPage(r.Attributes!);
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    const current = (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: key }))).Item;
    if (!current) throw new OpError('That page is gone.');
    if (lock) throw new OpError(`${String(current.editor)} is editing this page right now.`);
    return toPage(current); // releasing a lock we no longer hold: nothing to do
  }
}

export async function handler(event: WsEvent): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId } = event.requestContext;

  if (routeKey === '$connect') {
    const claims = await verifySession(event.queryStringParameters?.token);
    if (!claims) return { statusCode: 401 };
    const ttl = Math.floor(Date.now() / 1000) + CONN_TTL_HOURS * 3600;
    await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: { pk: `conn#${connectionId}`, sk: 'conn', room: claims.room, name: claims.name, gm: !!claims.gm, exp: claims.exp, ttl } }));
    await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: { pk: roomPk(claims.room), sk: connSk(connectionId), name: claims.name, ttl } }));
    return ok;
  }

  if (routeKey === '$disconnect') {
    await dropConnection(connectionId);
    return ok;
  }

  const conn = (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: { pk: `conn#${connectionId}`, sk: 'conn' } }))).Item;
  // Sockets can outlive their session token (they last up to 2 hours), so check expiry here too.
  if (!conn || (typeof conn.exp === 'number' && conn.exp < Date.now() / 1000)) {
    await send(event, connectionId, { type: 'error', message: 'Session expired. Leave and rejoin the room.' });
    return ok;
  }
  const room = conn.room as string;
  const name = conn.name as string;
  const canGm = conn.gm === true;

  let msg: ClientMessage;
  try {
    msg = JSON.parse(event.body ?? '');
  } catch {
    await send(event, connectionId, { type: 'error', message: 'Messages must be JSON.' });
    return ok;
  }

  switch (msg.type) {
    case 'ping':
      await send(event, connectionId, { type: 'pong', now: Date.now() });
      break;

    case 'hello': {
      const [state, log] = await Promise.all([loadState(room), recentLog(room, LOG_IN_SNAPSHOT)]);
      if (state) await send(event, connectionId, { type: 'snapshot', state, log: log.map(toEntry).reverse(), now: Date.now() });
      break;
    }

    case 'op':
      try {
        if (!msg.op || typeof msg.op !== 'object') throw new OpError('Missing op.');
        const entry = await commit(room, name, canGm, msg.op, String(msg.cid ?? '').slice(0, 40));
        await broadcast(event, room, { type: 'op', entry });
      } catch (e) {
        if (!(e instanceof OpError)) console.error(e);
        const message = e instanceof OpError ? e.message : 'Server error.';
        await send(event, connectionId, { type: 'error', cid: msg.cid, message });
      }
      break;

    case 'notes':
      await send(event, connectionId, { type: 'notes', pages: await allNotes(room) });
      break;

    case 'note.save':
    case 'note.lock':
      try {
        const page = msg.type === 'note.save'
          ? await saveNote(room, name, msg.page, msg.lock === true)
          : await lockNote(room, name, msg.id, msg.lock === true);
        await broadcast(event, room, { type: 'note', page, cid: String(msg.cid ?? '').slice(0, 40) });
      } catch (e) {
        if (!(e instanceof OpError)) console.error(e);
        await send(event, connectionId, { type: 'error', cid: msg.cid, message: e instanceof OpError ? e.message : 'Server error.' });
      }
      break;

    default:
      await send(event, connectionId, { type: 'error', message: 'Unknown message type.' });
  }
  return ok;
}
