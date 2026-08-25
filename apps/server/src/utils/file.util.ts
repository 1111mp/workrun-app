import crypto from 'node:crypto';

export function md5(buffer: Buffer | string) {
  const hash = crypto.createHash('md5');
  hash.update(buffer);
  return hash.digest('hex');
}
