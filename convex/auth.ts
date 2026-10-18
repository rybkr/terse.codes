export function assertServerSecret(secret: string): void {
  const expected = process.env.TERSE_SERVER_SECRET;
  if (expected === undefined || expected.length === 0 || secret.length !== expected.length || secret !== expected) {
    throw new Error('Unauthorized server request.');
  }
}
