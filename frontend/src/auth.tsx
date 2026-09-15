import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, type AuthRole, type AuthUser, type LoginCredentials } from '@/api';

type AuthStatus = 'loading' | 'ready';

interface AuthContextValue {
    user: AuthUser | null;
    role: AuthRole | null;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    hasRole: (roles: AuthRole[]) => boolean;
    status: AuthStatus;
    login: (credentials: LoginCredentials) => Promise<AuthUser>;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function formatAuthError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return 'Unable to complete authentication';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [status, setStatus] = useState<AuthStatus>('loading');

    const refresh = useCallback(async () => {
        try {
            const currentUser = await authApi.me();
            setUser(currentUser);
        } catch {
            setUser(null);
        } finally {
            setStatus('ready');
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, []);

    const login = useCallback(async (credentials: LoginCredentials) => {
        const nextUser = await authApi.login(credentials);
        setUser(nextUser);
        setStatus('ready');
        return nextUser;
    }, []);

    const logout = useCallback(async () => {
        try {
            await authApi.logout();
        } catch {
            // Ignore session teardown failures and clear local state.
        } finally {
            setUser(null);
            setStatus('ready');
        }
    }, []);

    // super_admin passes any role check, same invariant as the backend's require_role().
    const hasRole = useCallback((roles: AuthRole[]) => !!user && (user.role === 'super_admin' || roles.includes(user.role)), [user]);

    const value = useMemo<AuthContextValue>(() => ({
        user,
        role: user?.role ?? null,
        isAdmin: user?.role === 'admin' || user?.role === 'super_admin',
        isSuperAdmin: user?.role === 'super_admin',
        hasRole,
        status,
        login,
        logout,
        refresh,
    }), [user, status, login, logout, refresh, hasRole]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);

    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }

    return context;
}

