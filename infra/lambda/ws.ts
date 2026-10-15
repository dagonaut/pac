// Game-state WebSocket. Every op is resolved and applied here against the stored room state,
// written with an optimistic seq check (retried on conflict), logged, then broadcast to everyone
// in the room. Clients apply the broadcast op with the same shared engine.
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomInt, randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { apply, forbidden, OpError, publicNames, resolve } from '../../shared/engine.ts';
import type { LogEntry, Op, RoomState } from '../../shared/model.ts';
import { CHUNK_CHARS, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts';
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

    default:
      await send(event, connectionId, { type: 'error', message: 'Unknown message type.' });
  }
  return ok;
}
