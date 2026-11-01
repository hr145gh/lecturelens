import { Router, type Request } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { unauthenticated } from '../../utils/errors.js';
import { loginBody, registerBody, updateMeBody } from './auth.schemas.js';
import * as auth from './auth.service.js';

/** /auth and /users routes — CONTRACTS.md §5.2. Owner: D. */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** The signed-in user's id; requireAuth guarantees it on these routes. */
function userId(req: Pick<Request, 'user'>): string {
  if (!req.user) throw unauthenticated();
  return req.user.id;
}

export const authRouter = Router();

authRouter.post(
  '/register',
  rateLimit({ windowMs: FIFTEEN_MINUTES, max: 10 }),
  validate({ body: registerBody }),
  asyncHandler(async (req, res) => {
    const { user, token } = await auth.register(registerBody.parse(req.body));
    res.status(201).json({ user, token });
  }),
);

authRouter.post(
  '/login',
  // Failed attempts only: 10 wrong passwords per IP per 15 min, while normal sign-in/out never locks anyone out.
  rateLimit({ windowMs: FIFTEEN_MINUTES, max: 10, onlyFailures: true }),
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const { user, token } = await auth.login(loginBody.parse(req.body));
    res.json({ user, token });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: await auth.getUser(userId(req)) });
  }),
);

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({ user: await auth.getUser(userId(req)) });
  }),
);

usersRouter.patch(
  '/me',
  validate({ body: updateMeBody }),
  asyncHandler(async (req, res) => {
    res.json({ user: await auth.updateMe(userId(req), updateMeBody.parse(req.body)) });
  }),
);
