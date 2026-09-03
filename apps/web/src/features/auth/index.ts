/**
 * The auth feature's public surface. Nothing outside this folder imports its
 * files directly — same barrel rule the server modules follow.
 */
export { AuthProvider, useAuth } from './AuthContext';
export type { AuthStatus } from './AuthContext';
export { RequireAuth } from './RequireAuth';
export { LoginPage } from './LoginPage';
export { RegisterPage } from './RegisterPage';
