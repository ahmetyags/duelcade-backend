import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface FirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  signInProvider: string;
  providerSubject: string | null;
}

export interface FirebaseTokenVerifier {
  verify(idToken: string): Promise<FirebaseIdentity>;
}

export function createFirebaseTokenVerifier(projectId: string): FirebaseTokenVerifier {
  const keys = createRemoteJWKSet(new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ));
  return {
    async verify(idToken) {
      const { payload } = await jwtVerify(idToken, keys, {
        algorithms: ['RS256'],
        audience: projectId,
        issuer: `https://securetoken.google.com/${projectId}`,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        !payload.sub
        || typeof payload.iat !== 'number'
        || payload.iat > now + 60
        || typeof payload.auth_time !== 'number'
        || payload.auth_time > now + 60
      ) throw new Error('INVALID_FIREBASE_CLAIMS');
      const firebase = payload.firebase as {
        sign_in_provider?: unknown;
        identities?: unknown;
      } | undefined;
      const providerIdentities = firebase?.identities
        && typeof firebase.identities === 'object'
        && typeof firebase.sign_in_provider === 'string'
        ? (firebase.identities as Record<string, unknown>)[firebase.sign_in_provider]
        : undefined;
      const providerSubject = Array.isArray(providerIdentities)
        && typeof providerIdentities[0] === 'string'
        ? providerIdentities[0]
        : null;
      return {
        uid: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        displayName: typeof payload.name === 'string' ? payload.name : null,
        signInProvider: typeof firebase?.sign_in_provider === 'string'
          ? firebase.sign_in_provider
          : 'custom',
        providerSubject,
      };
    },
  };
}
