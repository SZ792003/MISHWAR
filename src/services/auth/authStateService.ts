import { onAuthStateChanged } from 'firebase/auth';
import { appConfig } from '../../config/appConfig';
import { auth, isFirebaseConfigured } from '../firebase/firebaseConfig';
import { authService as demoAuthService } from '../authService';
import { authService as firebaseAuthService } from '../firebase/authService';
import { AuthErrorReason, AuthMode, AuthState, AuthStatus, AuthenticatedUser, unauthenticatedAuthState } from './authTypes';

const currentMode = (): AuthMode => (appConfig.flags.useRealAuth ? 'production' : 'demo');

class AuthStateService {
  private listeners = new Set<(state: AuthState) => void>();
  private state: AuthState = {
    mode: currentMode(),
    status: 'loading',
    user: null
  };

  private notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  getSnapshot(): AuthState {
    if (!appConfig.flags.useRealAuth) {
      const session = demoAuthService.getCurrentSession();
      if (!session) return unauthenticatedAuthState('demo');

      return {
        mode: 'demo',
        status: 'authenticated',
        user: {
          uid: session.userId,
          role: session.role,
          phoneNumber: session.phone,
          idToken: session.token
        }
      };
    }

    if (!isFirebaseConfigured()) {
      return unauthenticatedAuthState('production');
    }

    return this.state;
  }

  async getIdToken(forceRefresh = false): Promise<string | null> {
    if (!appConfig.flags.useRealAuth) {
      return demoAuthService.getCurrentSession()?.token ?? null;
    }

    if (!isFirebaseConfigured() || !auth.currentUser) return null;
    return auth.currentUser.getIdToken(forceRefresh);
  }

  async refreshIdToken(): Promise<string | null> {
    const token = await this.getIdToken(true);
    if (token && this.state.user) {
      this.state = {
        ...this.state,
        user: {
          ...this.state.user,
          idToken: token
        }
      };
      this.notify();
    }
    return token;
  }

  async logout(reason: AuthErrorReason = 'signedOut', message?: string): Promise<void> {
    if (appConfig.flags.useRealAuth) {
      await firebaseAuthService.logout();
      this.state = unauthenticatedAuthState('production', reason, message);
    } else {
      demoAuthService.logout();
      this.state = unauthenticatedAuthState('demo', reason, message);
    }
    this.notify();
  }

  markUnauthenticated(reason: AuthErrorReason, message?: string): void {
    this.state = unauthenticatedAuthState(currentMode(), reason, message);
    this.notify();
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);

    if (!appConfig.flags.useRealAuth || !isFirebaseConfigured()) {
      const snapshot = this.getSnapshot();
      this.state = snapshot;
      listener(snapshot);
      return () => {
        this.listeners.delete(listener);
      };
    }

    this.state = { mode: 'production', status: 'loading', user: null };
    listener(this.state);

    const unsubscribeFirebase = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        this.state = unauthenticatedAuthState('production', this.state.reason, this.state.message);
        this.notify();
        return;
      }

      const idTokenResult = await firebaseUser.getIdTokenResult();
      const user: AuthenticatedUser = {
        uid: firebaseUser.uid,
        role: idTokenResult.claims.role as AuthenticatedUser['role'],
        phoneNumber: firebaseUser.phoneNumber ?? undefined,
        email: firebaseUser.email ?? undefined,
        idToken: idTokenResult.token
      };

      this.state = {
        mode: 'production',
        status: 'authenticated' as AuthStatus,
        user
      };
      this.notify();
    });

    return () => {
      this.listeners.delete(listener);
      unsubscribeFirebase();
    };
  }
}

export const authStateService = new AuthStateService();
