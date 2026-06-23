import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/enums.js';
import { AuthenticatedUser } from './user.types.js';

export type UserResolver = (req: Request) => AuthenticatedUser | undefined;

/** Resuelve el usuario desde la request (p. ej. JWT). Sustituir en producción. */
export const defaultUserResolver: UserResolver = (req) => req.user;

export const authenticate = (resolveUser: UserResolver = defaultUserResolver) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = resolveUser(req);

    if (!user) {
      res.status(401).json({ message: 'No autenticado' });
      return;
    }

    req.user = user;
    next();
  };
};

export const authorize = (allowedRoles: readonly UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'No autenticado' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ message: 'Acceso denegado' });
      return;
    }

    next();
  };
};