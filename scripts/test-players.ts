// Temporary players for the browser test, written straight into the Game table (the test can't
// use the admin API without a real admin's link). Ids start with "zz" so cleanup can find them.
// Needs AWS credentials for the stack's account (AWS_PROFILE=pac) and region us-west-2.
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';

const raw = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
const ddb = DynamoDBDocumentClient.from(raw);

async function gameTable() {
  const { TableNames = [] } = await raw.send(new ListTablesCommand({}));
  const t = TableNames.find((n) => n.startsWith('PacVtt-Game'));
  if (!t) throw new Error('No PacVtt-Game table found (is AWS_PROFILE=pac set?).');
  return t;
}

export interface TestPlayer { id: string; name: string; credential: string }

export async function makeTestPlayers(specs: { name: string; color: string; admin: boolean; gm: boolean }[]) {
  const table = await gameTable();
  const tag = Date.now().toString(36).slice(-6);
  const made: TestPlayer[] = [];
  for (const [i, s] of specs.entries()) {
    const id = `zz${tag}${i}`;
    const secret = randomBytes(24).toString('base64url');
    await ddb.send(new PutCommand({
      TableName: table,
      Item: { pk: 'players', sk: `player#${id}`, id, name: s.name, color: s.color, admin: s.admin, gm: s.gm, secret, created: new Date().toISOString() },
    }));
    made.push({ id, name: s.name, credential: `${id}.${secret}` });
  }
  return {
    players: made,
    async remove() {
      for (const p of made) await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: 'players', sk: `player#${p.id}` } }));
    },
  };
}
