import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { requireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestId } from '../src/middleware/requestId.js';
import { requireOwnerOrRole, requireRole } from '../src/middleware/rbac.js';
import { User } from '../src/models/index.js';
import { resetDb } from './setup.js';
import { INVALID_CREDENTIALS } from '../src/modules/auth/auth.service.js';

beforeEach(resetDb);

const api = () => request(app);

const teacher = { name: 'Dr. Ananya Rao', email: 'Teacher@Example.edu', password: 'chalkboard9', role: 'teacher' };
const student = { name: 'Rohan Mehta', email: 'rohan@example.edu', password: 'notebook42', role: 'student' };

async function registerAndGetToken(body: typeof teacher): Promise<string> {
  const res = await api().post('/api/v1/auth/register').send(body).expect(201);
  return res.body.token as string;
}

const expectEnvelope = (body: { error: Record<string, unknown> }, code: string) => {
  expect(body.error).toMatchObject({ code, details: expect.any(Object), requestId: expect.stringMatching(/^req_/) });
  expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
};

describe('POST /auth/register', () => {
  it('creates the account and returns { user, token } with no password hash', async () => {
    const res = await api().post('/api/v1/auth/register').send(teacher).expect(201);
    expect(res.body.user).toMatchObject({ email: 'teacher@example.edu', name: 'Dr. Ananya Rao', role: 'teacher' });
    expect(res.body.user.id).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const stored = await User.findOne({ email: 'teacher@example.edu' }).select('+passwordHash');
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$10\$/); // bcrypt, cost 10
  });

  it('puts only sub and role in the JWT', async () => {
    const token = await registerAndGetToken(teacher);
    const claims = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'role', 'sub']);
    expect(claims.role).toBe('teacher');
  });

  it('returns 409 CONFLICT for an email that already exists (any case)', async () => {
    await registerAndGetToken(teacher);
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ ...student, email: 'TEACHER@example.edu' })
      .expect(409);
    expectEnvelope(res.body, 'CONFLICT');
  });

  it('returns 422 with a field map for a weak password and other bad fields', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'A', email: 'not-an-email', password: 'password', role: 'admin' })
      .expect(422);
    expectEnvelope(res.body, 'VALIDATION_FAILED');
    expect(res.body.error.details).toEqual({
      name: 'Must be 2–80 characters',
      email: 'Must be a valid email address',
      password: 'Must contain at least one digit',
      role: 'Must be "student" or "teacher"',
    });
  });
});

describe('registration persists', () => {
  it('a newly registered user is saved in MongoDB before 201, and can log in afterwards', async () => {
    const before = await User.countDocuments();
    const reg = await api().post('/api/v1/auth/register').send(student).expect(201);

    // Persisted by the time the response arrived — not deferred, not mocked.
    const stored = await User.findById(reg.body.user.id).select('+passwordHash').lean();
    expect(await User.countDocuments()).toBe(before + 1);
    expect(stored).toMatchObject({ email: student.email, name: student.name, role: 'student' });
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$10\$/); // hashed, never the plain password
    expect(stored?.passwordHash).not.toContain(student.password);
    expect(stored?.createdAt).toBeInstanceOf(Date);

    // A completely separate login with the same credentials finds that same document.
    const login = await api().post('/api/v1/auth/login').send({ email: student.email, password: student.password }).expect(200);
    expect(login.body.user.id).toBe(reg.body.user.id);
    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
    expect(me.body.user).toMatchObject({ id: reg.body.user.id, email: student.email });
  });
});

describe('sign-up → sign-out → sign-in lifecycle (regression)', () => {
  const creds = { email: student.email, password: student.password };

  it('signing in and out many times never locks out the account (only failures are rate-limited)', async () => {
    const reg = await api().post('/api/v1/auth/register').send(student).expect(201);
    // Logging out is client-side (the token is discarded); there is no server call that touches the user.
    for (let i = 1; i <= 15; i++) {
      const res = await api().post('/api/v1/auth/login').send(creds);
      expect(res.status, `login #${i}`).toBe(200);
      expect(res.body.user.id).toBe(reg.body.user.id);
    }
    expect(await User.countDocuments({ email: student.email })).toBe(1); // still there, exactly once
  });

  it('failed attempts are still limited, and a correct password does not reset an attacker\'s budget', async () => {
    await api().post('/api/v1/auth/register').send(student).expect(201);
    await api().post('/api/v1/auth/login').send(creds).expect(200); // successes don't count…
    for (let i = 0; i < 10; i++) await api().post('/api/v1/auth/login').send({ ...creds, password: 'wrong-password1' }).expect(401);
    const blocked = await api().post('/api/v1/auth/login').send(creds).expect(429); // …but 10 failures do
    expect(blocked.body.error.message).toMatch(/^Too many attempts\. Please try again in \d+ minutes?\.$/);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
  });

  it('logging in with a differently-cased or padded email finds the same persisted user', async () => {
    const reg = await api().post('/api/v1/auth/register').send({ ...student, email: '  Rohan.Mehta@Example.EDU ' }).expect(201);
    const stored = await User.findOne({ email: 'rohan.mehta@example.edu' });
    expect(stored?.id).toBe(reg.body.user.id);
    const login = await api().post('/api/v1/auth/login').send({ email: 'ROHAN.MEHTA@example.edu', password: student.password }).expect(200);
    expect(login.body.user.id).toBe(reg.body.user.id);
  });

  it('a database failure is a 500 with no token and no user — never a false success', async () => {
    vi.spyOn(User, 'create').mockRejectedValueOnce(new Error('connection reset by Atlas'));
    const res = await api().post('/api/v1/auth/register').send(student).expect(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', details: {} });
    expect(JSON.stringify(res.body)).not.toMatch(/token|Atlas|connection reset/);
    expect(await User.countDocuments({ email: student.email })).toBe(0);
    vi.restoreAllMocks();
    // The same registration succeeds once the database is back, and can sign in.
    await api().post('/api/v1/auth/register').send(student).expect(201);
    await api().post('/api/v1/auth/login').send(creds).expect(200);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await registerAndGetToken(teacher);
  });

  it('returns { user, token } for the right password', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: '  teacher@EXAMPLE.edu ', password: teacher.password })
      .expect(200);
    // Exactly the contract's user object (§5.2).
    expect(Object.keys(res.body.user).sort()).toEqual(['createdAt', 'email', 'id', 'lastLoginAt', 'name', 'role', 'updatedAt']);
    expect(res.body.user.email).toBe('teacher@example.edu');
    expect(Date.parse(res.body.user.lastLoginAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('gives a wrong password and an unknown email the same 401 and message', async () => {
    const wrongPassword = await api()
      .post('/api/v1/auth/login')
      .send({ email: teacher.email, password: 'wrong-password1' })
      .expect(401);
    const unknownEmail = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.edu', password: 'wrong-password1' })
      .expect(401);
    expectEnvelope(wrongPassword.body, 'UNAUTHENTICATED');
    expect(wrongPassword.body.error.message).toBe(INVALID_CREDENTIALS);
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknownEmail.body.error.details).toEqual(wrongPassword.body.error.details);
  });

  it('rate-limits to 10 attempts per IP per 15 minutes with 429', async () => {
    for (let i = 0; i < 10; i++) {
      await api().post('/api/v1/auth/login').send({ email: teacher.email, password: 'wrong-password1' }).expect(401);
    }
    const res = await api().post('/api/v1/auth/login').send({ email: teacher.email, password: teacher.password }).expect(429);
    expectEnvelope(res.body, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /auth/me', () => {
  it('returns the user for a valid token', async () => {
    const token = await registerAndGetToken(student);
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({ user: expect.objectContaining({ email: student.email, role: 'student' }) });
  });

  it('returns 401 without a token', async () => {
    const res = await api().get('/api/v1/auth/me').expect(401);
    expectEnvelope(res.body, 'UNAUTHENTICATED');
  });

  it('returns 401 for a tampered token', async () => {
    const token = await registerAndGetToken(student);
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'teacher' })).toString('base64url');
    const res = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${header}.${forged}.${signature}`)
      .expect(401);
    expectEnvelope(res.body, 'UNAUTHENTICATED');
    expect(res.body.error.details).toEqual({});
  });

  it('returns 401 with reason "expired" for an expired token', async () => {
    const token = await registerAndGetToken(student);
    const { sub } = jwt.decode(token) as jwt.JwtPayload;
    const expired = jwt.sign({ role: 'student' }, env.JWT_SECRET, { subject: sub, expiresIn: -10 });
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
    expect(res.body.error.details).toEqual({ reason: 'expired' });
  });

  it('returns 401 for a malformed Authorization header and for a deleted user', async () => {
    await api().get('/api/v1/auth/me').set('Authorization', 'Token abc').expect(401);
    const token = await registerAndGetToken(student);
    await User.deleteMany({});
    await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  });
});

describe('/users/me', () => {
  it('updates the name only', async () => {
    const token = await registerAndGetToken(student);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await api().patch('/api/v1/users/me').set(auth).send({ name: 'Rohan M.' }).expect(200);
    expect(res.body.user.name).toBe('Rohan M.');
    const refused = await api().patch('/api/v1/users/me').set(auth).send({ name: 'Rohan', role: 'teacher' }).expect(422);
    expect(refused.body.error.details).toEqual({ body: 'Only "name" can be changed' });
    expect((await api().get('/api/v1/users/me').set(auth).expect(200)).body.user).toMatchObject({ name: 'Rohan M.', role: 'student' });
  });
});

describe('RBAC', () => {
  // Test-only routes using the real middleware and error handler.
  const rbacApp = express();
  rbacApp.use(requestId);
  rbacApp.get('/teacher-only', requireAuth, requireRole('teacher'), (_req, res) => res.json({ ok: true }));
  rbacApp.get(
    '/attempts/:ownerId',
    requireAuth,
    requireOwnerOrRole((req) => req.params.ownerId),
    (_req, res) => res.json({ ok: true }),
  );
  rbacApp.use(errorHandler);

  it('rejects a student token on a teacher-only route with 403 and allows a teacher', async () => {
    const studentToken = await registerAndGetToken(student);
    const teacherToken = await registerAndGetToken(teacher);
    const res = await request(rbacApp).get('/teacher-only').set('Authorization', `Bearer ${studentToken}`).expect(403);
    expectEnvelope(res.body, 'FORBIDDEN');
    await request(rbacApp).get('/teacher-only').set('Authorization', `Bearer ${teacherToken}`).expect(200);
  });

  it('lets only the owner through requireOwnerOrRole when no role is given', async () => {
    const token = await registerAndGetToken(student);
    const otherToken = await registerAndGetToken(teacher);
    const { sub } = jwt.decode(token) as jwt.JwtPayload;
    await request(rbacApp).get(`/attempts/${sub}`).set('Authorization', `Bearer ${token}`).expect(200);
    await request(rbacApp).get(`/attempts/${sub}`).set('Authorization', `Bearer ${otherToken}`).expect(403);
  });
});
