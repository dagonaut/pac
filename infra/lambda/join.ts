// POST /api/join { room, name, key } -> { meeting, attendee }
// Finds the live Chime meeting for a room (or creates one) and adds an attendee.
import {
  ChimeSDKMeetingsClient,
  CreateAttendeeCommand,
  CreateMeetingCommand,
  DeleteMeetingCommand,
  GetMeetingCommand,
  type Meeting,
} from '@aws-sdk/client-chime-sdk-meetings';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Chime's meeting API lives in a "control" region (us-east-1); the media itself runs in MEDIA_REGION.
const chime = new ChimeSDKMeetingsClient({ region: process.env.CHIME_CONTROL_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

const TABLE = process.env.ROOMS_TABLE!;
const MEDIA_REGION = process.env.CHIME_MEDIA_REGION!;
const KEY_SECRET_ARN = process.env.TABLE_KEY_SECRET_ARN!;

let cachedKey: string | undefined;
async function tableKey(): Promise<string> {
  cachedKey ??= (await secrets.send(new GetSecretValueCommand({ SecretId: KEY_SECRET_ARN }))).SecretString!;
  return cachedKey;
}

function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

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
  const existing = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { room } }))).Item;
  if (existing) {
    const live = await liveMeeting(existing.meetingId);
    if (live) return live;
  }

  const created = (
    await chime.send(
      new CreateMeetingCommand({
        ClientRequestToken: randomUUID(),
        MediaRegion: MEDIA_REGION,
        ExternalMeetingId: room,
      }),
    )
  ).Meeting!;

  try {
    // Only claim the room if nobody else replaced the (stale) meeting in the meantime.
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: Record<string, unknown>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body;
    body = JSON.parse(raw || '{}');
  } catch {
    return json(400, { error: 'Request body must be JSON.' });
  }

  const room = String(body.room ?? '').trim().toLowerCase();
  // ExternalUserId only allows a limited character set, so strip anything exotic (emoji etc.).
  const name = String(body.name ?? '')
    .replace(/[^a-zA-Z0-9À-ÿ .,'()_-]/g, '')
    .trim()
    .slice(0, 40);

  if (!/^[a-z0-9-]{1,40}$/.test(room)) return json(400, { error: 'Room must be 1–40 letters, numbers or dashes.' });
  if (!name) return json(400, { error: 'Enter a name.' });
  if (!keyMatches(String(body.key ?? ''), await tableKey())) return json(403, { error: 'Wrong table key.' });

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

  return json(200, { meeting, attendee });
}
