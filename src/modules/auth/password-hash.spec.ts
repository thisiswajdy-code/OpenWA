import { hashPassword, verifyPassword } from './password-hash';

describe('password hashing', () => {
  it('verifies the password a hash was made from and refuses any other', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery stapl', stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  it('salts every hash, so equal passwords do not share a hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same', b)).resolves.toBe(true);
  });

  it('keeps verifying a hash made with other parameters, read from the string itself', async () => {
    // A cheaper hash than hashPassword writes today, as an earlier release could have stored it.
    const { scryptSync } = await import('crypto');
    const salt = Buffer.from('0123456789abcdef');
    const key = scryptSync('old', salt, 64, { N: 1024, r: 8, p: 1 });
    const stored = ['scrypt', 1024, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
    await expect(verifyPassword('old', stored)).resolves.toBe(true);
  });

  it.each(['', 'plain', 'bcrypt$x$y$z$w$v', 'scrypt$0$8$1$c2FsdA==$aGFzaA==', 'scrypt$1024$8$1$$', 'scrypt$a$b$c$d$e'])(
    'answers false, never throws, for a malformed stored value %j',
    async stored => {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    },
  );
});
