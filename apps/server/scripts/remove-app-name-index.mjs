import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) process.loadEnvFile('.env');
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const apps = client.db().collection('apps');
  const indexes = await apps.indexes().catch((error) => {
    if (error.code === 26) return [];
    throw error;
  });
  let removed = 0;
  for (const index of indexes) {
    const { key } = index;
    if (
      index.unique &&
      Object.keys(key).length === 3 &&
      key.ownerId === 1 &&
      key.name === 1 &&
      key.version === 1
    ) {
      await apps.dropIndex(index.name);
      removed += 1;
    }
  }
  console.log(`Removed ${removed} obsolete App name/version unique indexes.`);
} catch (error) {
  // Connection errors can contain credentials; report only their classification.
  console.error(
    `App index update failed: ${error.name} (${error.code ?? 'unknown'})`,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
