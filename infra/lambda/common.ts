// Helpers shared by the HTTP API and the WebSocket handler.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RoomState } from '../../shared/model.ts';
import type { SessionClaims } from '../../shared/protocol.ts';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secrets = new SecretsManagerClient({});

/** Game table: room state, action log and WebSocket connections (see keys below). */
export const GAME_TABLE = process.env.GAME_TABLE!;
export const roomPk = (room: string) => `room#${room}`;
export const STATE_SK = 'state';
export const logSk = (seq: number) => `log#${String(seq).padStart(10, '0')}`;
export const connSk = (connectionId: string) => `conn#${connectionId}`;

// Cached briefly so a rotated key takes effect within minutes, even in warm Lambdas.
const KEY_TTL_MS = 5 * 60_000;
let cachedKey: { value: string; at: number } | undefined;
export async function tableKey(): Promise<string> {
  if (!cachedKey || Date.now() - cachedKey.at > KEY_TTL_MS) {
    const value = (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.TABLE_KEY_SECRET_ARN! }))).SecretString!;
    cachedKey = { value, at: Date.now() };
  }
  return cachedKey.value;
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function keyMatches(given: unknown): Promise<boolean> {
  return equal(String(given ?? ''), await tableKey());
}

// Session tokens are signed with a key derived from the table key, so rotating the table key
// also logs everyone out. Format: base64url(json claims).base64url(hmac)
async function signingKey() {
  return createHmac('sha256', await tableKey()).update('pac-vtt-session-v1').digest();
}

export async function signSession(claims: SessionClaims): Promise<string> {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', await signingKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export async function verifySession(token: string | undefined): Promise<SessionClaims | null> {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', await signingKey()).update(body).digest('base64url');
  if (!equal(sig, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionClaims;
  return claims.exp > Date.now() / 1000 ? claims : null;
}

export const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export async function loadState(room: string): Promise<RoomState | null> {
  const item = (await ddb.send(new GetCommand({ TableName: GAME_TABLE, Key: { pk: roomPk(room), sk: STATE_SK } }))).Item;
  return item ? (JSON.parse(item.data) as RoomState) : null;
}

/** DynamoDB item for a room's state. Summary fields are copied out for the lobby list.
 *  Writing it drops `archived`, so playing in an archived room brings it back to the lobby. */
export function stateItem(state: RoomState) {
  return {
    pk: roomPk(state.id),
    sk: STATE_SK,
    seq: state.seq,
    name: state.name,
    system: state.system,
    updated: new Date().toISOString(),
    data: JSON.stringify(state),
  };
}

/** DynamoDB items max out at 400 KB; refuse ops that would grow a room's state past this. */
export const MAX_STATE_CHARS = 350_000;

/** Names go into Chime's ExternalUserId, which only allows a limited character set. */
export function cleanName(raw: unknown): string {
  return String(raw ?? '').replace(/[^a-zA-Z0-9À-ÿ .,'()_-]/g, '').trim().slice(0, 40);
}
