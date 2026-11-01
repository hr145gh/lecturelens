import { rm } from 'node:fs/promises';
import type { Express } from 'express';
import mongoose, { Types, type HydratedDocument } from 'mongoose';
import { afterAll, beforeAll } from 'vitest';
import { storageRoot } from '../src/config/env.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { User, type IUser, type Role } from '../src/models/index.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { signToken } from '../src/modules/auth/tokens.js';
import {
  notImplementedPipeline,
  setPipeline,
} from '../src/services/processing/pipeline.js';

/**
 * Backend test harness (vitest `setupFiles`). Every test file gets a real, throwaway MongoDB:
 * mongodb-memory-server when it starts; otherwise the database named in server/.env's
 * MONGODB_URI with `_test` appended (never the real one). Files run one at a time in a single
 * fork (vitest.config.ts), so they never race on the database.
 */

type MemoryServer = {
  getUri(): string;
  stop(): Promise<boolean>;
};

let memoryServer: MemoryServer | undefined;

/** The real database's name + "_test", from the URI vitest.config.ts passes as FALLBACK_MONGODB_URI. */
function fallbackTarget(): { uri: string; dbName: string } | null {
  const uri = process.env.FALLBACK_MONGODB_URI;
  if (!uri) return null;

  const name =
    new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.slice(1) ||
    'lecturelens';

  return { uri, dbName: `${name}_test` };
}

async function connect(): Promise<void> {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();

    await mongoose.connect(memoryServer.getUri(), {
      dbName: 'lecturelens-test',
    });
  } catch (err) {
    const target = fallbackTarget();

    if (!target) {
      throw new Error(
        `mongodb-memory-server failed and no MONGODB_URI fallback is set: ${(err as Error).message}`,
      );
    }

    console.warn(
      `mongodb-memory-server unavailable; using database "${target.dbName}"`,
    );

    await mongoose.connect(target.uri, { dbName: target.dbName });
  }

  await Promise.all(
    mongoose.modelNames().map((name) => mongoose.model(name).init()),
  );
}

beforeAll(connect);

afterAll(async () => {
  await mongoose.disconnect();
  await memoryServer?.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ helpers ---- */

/**
 * Loads the Express app lazily.
 *
 * Important: do not statically import app.js in this setup file.
 * Individual test files must be able to apply vi.mock() before app.js
 * and its route modules are imported.
 */
export async function buildApp(): Promise<Express> {
  const { createApp } = await import('../src/app.js');
  return createApp();
}

/**
 * Default pipeline for API tests: does nothing, so no test spawns FFmpeg or calls an ASR provider
 * in the background. Tests of the real pipeline install `processingPipeline` themselves.
 */
export const idlePipeline: ProcessingPipeline = { startProcessing: async () => undefined };

/** Empties every collection (indexes kept), rate limits, stored media, and installs the idle pipeline. */
export async function resetDb(): Promise<void> {
  const db = mongoose.connection.db;

  if (!db) {
    throw new Error('resetDb() called before the test database connected');
  }

  if (!memoryServer && !db.databaseName.endsWith('_test')) {
    throw new Error(`Refusing to wipe "${db.databaseName}": not a test database`);
  }

  for (const collection of await db.collections()) {
    await collection.deleteMany({});
  }

  resetRateLimits();
  setPipeline(notImplementedPipeline);

  await rm(storageRoot, { recursive: true, force: true });
}

export const TEST_PASSWORD = 'chalkboard9';

let userCounter = 0;

async function makeUser(
  role: Role,
  overrides: Partial<IUser> = {},
): Promise<HydratedDocument<IUser>> {
  userCounter += 1;

  return User.create({
    _id: new Types.ObjectId(),
    email: `${role}${userCounter}@example.edu`,
    name:
      role === 'teacher'
        ? `Dr. Teacher ${userCounter}`
        : `Student ${userCounter}`,
    role,
    passwordHash: await hashPassword(TEST_PASSWORD, 4),
    ...overrides,
  });
}

export const makeTeacher = (overrides?: Partial<IUser>) =>
  makeUser('teacher', overrides);

export const makeStudent = (overrides?: Partial<IUser>) =>
  makeUser('student', overrides);

/** `{ Authorization: "Bearer <jwt>" }` for a user from makeTeacher/makeStudent. */
export function authHeader(user: {
  _id: Types.ObjectId;
  role: Role;
}): { Authorization: string } {
  return {
    Authorization: `Bearer ${signToken(String(user._id), user.role)}`,
  };
}