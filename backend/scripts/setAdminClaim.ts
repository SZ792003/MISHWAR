import { setTrustedRoleClaim } from '../src/trustedRoles';

const uid = process.argv[2];

if (!uid) {
  console.error('Usage: npm run set-admin -- <firebase-uid>');
  process.exit(1);
}

try {
  await setTrustedRoleClaim(uid, 'ADMIN');
  console.log(`Trusted ADMIN claim set for Firebase UID: ${uid}`);
  console.log('Ask this admin user to sign out and sign in again so the refreshed ID token contains the new claim.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  console.error(`Failed to set admin claim: ${message}`);
  process.exit(1);
}
