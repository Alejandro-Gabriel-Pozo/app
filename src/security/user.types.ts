import { UserRole } from '../types/enums.js';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}