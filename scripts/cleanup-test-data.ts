// Deletes test data left by smoke.ts / ui.ts: rooms whose id starts "zz-" (state, log,
// connections, meeting rows), their uploads under assets/zz-*, and test players ("zz" ids) and
// their portraits. Nothing else is touched.
//   AWS_PROFILE=pac npx tsx scripts/cleanup-test-data.ts          # dry run: counts only
//   AWS_PROFILE=pac npx tsx scripts/cleanup-test-data.ts --delete
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListBucketsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION ?? 'us-west-2';
const doIt = process.argv.includes('--delete');
const raw = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(raw);
const s3 = new S3Client({ region });

const { TableNames = [] } = await raw.send(new ListTablesCommand({}));
const game = TableNames.find((n) => n.startsWith('PacVtt-Game'))!;
const rooms = TableNames.find((n) => n.startsWith('PacVtt-Rooms'))!;
const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
const bucket = Buckets.map((b) => b.Name!).find((n) => n.startsWith('pacvtt-assets'))!;
if (!game || !rooms || !bucket) throw new Error('Could not find the PacVtt tables/bucket (is AWS_PROFILE=pac set?).');

async function scanAll(table: string, filter: string, values: Record<string, string>, names?: Record<string, string>) {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: table, FilterExpression: filter, ExpressionAttributeValues: values, ExpressionAttributeNames: names,
      ProjectionExpression: names ? Object.keys(names).join(', ') : undefined, ExclusiveStartKey: start,
    }));
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

async function deleteKeys(table: string, keys: Record<string, unknown>[]) {
  for (let i = 0; i < keys.length; i += 25) {
    let items: Record<string, unknown> | undefined = { [table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    while (items && Object.keys(items).length) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: items as never }));
      items = r.UnprocessedItems as Record<string, unknown> | undefined;
    }
  }
}

// Game: room#zz-* (state, log, connection rows) and test players.
const gameItems = await scanAll(game, 'begins_with(#pk, :r) OR (#pk = :p AND begins_with(#sk, :z))',
  { ':r': 'room#zz-', ':p': 'players', ':z': 'player#zz' }, { '#pk': 'pk', '#sk': 'sk' });
const gameKeys = gameItems.map((i) => ({ pk: i.pk, sk: i.sk }));
// Rooms (meetings): room = zz-*
const roomKeys = (await scanAll(rooms, 'begins_with(#room, :r)', { ':r': 'zz-' }, { '#room': 'room' })).map((i) => ({ room: i.room }));
// Assets
const objects: string[] = [];
for (const prefix of ['assets/zz-', 'assets/players/zz']) {
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    objects.push(...(r.Contents ?? []).map((o) => o.Key!));
    token = r.NextContinuationToken;
  } while (token);
}

console.log(`Game items: ${gameKeys.length} (${new Set(gameKeys.map((k) => k.pk)).size} rooms/players), meeting rows: ${roomKeys.length}, asset files: ${objects.length}`);
if (!doIt) {
  console.log('Dry run. Add --delete to delete them.');
} else {
  await deleteKeys(game, gameKeys);
  await deleteKeys(rooms, roomKeys);
  for (let i = 0; i < objects.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
  console.log('Deleted.');
}
