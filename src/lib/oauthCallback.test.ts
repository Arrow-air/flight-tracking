import { describe, expect, it } from 'vitest';
import { extractOAuthError } from './oauthCallback';

const clean = { hash: '', search: '' };

describe('extractOAuthError (A1 GitHub OAuth callback)', () => {
  it('null on a normal page load (no OAuth params)', () => {
    expect(extractOAuthError(clean)).toBeNull();
    expect(extractOAuthError({ hash: '#', search: '?foo=bar' })).toBeNull();
  });

  it('null on a SUCCESS callback (tokens in hash must be left alone)', () => {
    expect(
      extractOAuthError({
        hash: '#access_token=abc&refresh_token=def&token_type=bearer',
        search: '',
      }),
    ).toBeNull();
  });

  it('reads error_description from the hash (implicit flow)', () => {
    expect(
      extractOAuthError({
        hash: '#error=access_denied&error_description=The+user+has+denied+your+application+access',
        search: '',
      }),
    ).toBe('The user has denied your application access');
  });

  it('decodes %20-escaped descriptions', () => {
    expect(
      extractOAuthError({
        hash: '#error=server_error&error_description=Error%20getting%20user%20email',
        search: '',
      }),
    ).toBe('Error getting user email');
  });

  it('falls back to the error code when no description is given', () => {
    expect(extractOAuthError({ hash: '#error=access_denied', search: '' })).toBe(
      'access_denied',
    );
  });

  it('reads errors from the query string (PKCE flow)', () => {
    expect(
      extractOAuthError({
        hash: '',
        search: '?error=invalid_request&error_description=bad+redirect',
      }),
    ).toBe('bad redirect');
  });
});
