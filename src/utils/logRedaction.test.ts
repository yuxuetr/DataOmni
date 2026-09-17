import { describe, expect, it } from 'vitest';
import { redactLogValue, redactSensitiveText } from './logRedaction';

describe('log redaction', () => {
  it('redacts credentials embedded in connection URLs', () => {
    expect(
      redactSensitiveText('connect postgres://admin:s3cret@localhost:5432/app')
    ).toBe('connect postgres://admin:***@localhost:5432/app');
  });

  it('redacts sensitive query parameters and bearer tokens', () => {
    expect(
      redactSensitiveText('https://api.test/items?token=abc123&limit=10 Bearer jwt.value')
    ).toBe('https://api.test/items?token=***&limit=10 Bearer ***');
  });

  it('redacts sensitive fields recursively without changing safe fields', () => {
    expect(redactLogValue({
      username: 'admin',
      password: 'secret',
      nested: {
        authorization: 'Bearer token',
        host: 'localhost'
      }
    })).toEqual({
      username: 'admin',
      password: '***',
      nested: {
        authorization: '***',
        host: 'localhost'
      }
    });
  });

  it('redacts secrets in error messages and stacks', () => {
    const error = new Error('failed postgres://admin:secret@localhost/app');
    const redacted = redactLogValue(error);

    expect(redacted).toMatchObject({
      name: 'Error',
      message: 'failed postgres://admin:***@localhost/app'
    });
    expect(JSON.stringify(redacted)).not.toContain('secret@');
  });
});
