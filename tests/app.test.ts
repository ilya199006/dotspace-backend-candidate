import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { Registration, sequelize, User } from '../src/models';
import { migrateDatabase } from '../src/scripts/migrate';
import {
  SEED_EVENT_IDS,
  seedDatabase,
  seedUserId,
} from '../src/scripts/seed';
import autocannon from 'autocannon'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000999';

beforeAll(async () => {
  if (!sequelize.getDatabaseName().endsWith('_test')) {
    throw new Error(
      `Refusing to truncate non-test database "${sequelize.getDatabaseName()}"`,
    );
  }

  await sequelize.authenticate();
  await migrateDatabase();
});

beforeEach(async () => {
  await sequelize.query('TRUNCATE TABLE registrations, events, users CASCADE;');
  await seedDatabase();
});

afterAll(async () => {
  await sequelize.close();
});

describe('event API', () => {
  it('reports that the service is healthy', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('lists seeded events with the current number of free places', async () => {
    const response = await request(app).get('/events');

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(3);
    expect(response.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SEED_EVENT_IDS.main,
          capacity: 10,
          registeredCount: 0,
          freePlaces: 10,
        }),
      ]),
    );
  });

  it('returns an event by id', async () => {
    const response = await request(app).get(`/events/${SEED_EVENT_IDS.main}`);

    expect(response.status).toBe(200);
    expect(response.body.event).toEqual(
      expect.objectContaining({
        id: SEED_EVENT_IDS.main,
        capacity: 10,
        registeredCount: 0,
      }),
    );
  });
});

describe('registration API', () => {
  it('creates a registration', async () => {
    const response = await request(app)
      .post(`/events/${SEED_EVENT_IDS.main}/registrations`)
      .send({ userId: seedUserId(1) });

    expect(response.status).toBe(201);
    expect(response.body.registration).toEqual(
      expect.objectContaining({
        eventId: SEED_EVENT_IDS.main,
        userId: seedUserId(1),
      }),
    );
    expect(await Registration.count()).toBe(1);
  });

  it('returns the existing registration for a sequential retry', async () => {
    const first = await request(app)
      .post(`/events/${SEED_EVENT_IDS.main}/registrations`)
      .send({ userId: seedUserId(1) });
    const retry = await request(app)
      .post(`/events/${SEED_EVENT_IDS.main}/registrations`)
      .send({ userId: seedUserId(1) });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.registration.id).toBe(first.body.registration.id);
    expect(await Registration.count()).toBe(1);
  });

  it('rejects a new participant when an event is full', async () => {
    const first = await request(app)
      .post(`/events/${SEED_EVENT_IDS.singleSeat}/registrations`)
      .send({ userId: seedUserId(1) });
    const second = await request(app)
      .post(`/events/${SEED_EVENT_IDS.singleSeat}/registrations`)
      .send({ userId: seedUserId(2) });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EVENT_FULL');
    expect(await Registration.count()).toBe(1);
  });

  it('returns 404 for an unknown event', async () => {
    const response = await request(app)
      .post(`/events/${UNKNOWN_ID}/registrations`)
      .send({ userId: seedUserId(1) });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('returns 404 for an unknown user', async () => {
    const response = await request(app)
      .post(`/events/${SEED_EVENT_IDS.main}/registrations`)
      .send({ userId: UNKNOWN_ID });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });
  it('check concurrency thru autocannon', async () => {
    let users = await User.findAll()
    let userCounter = 0;

    function setupClient(client: any) {
      client.setBody(`{ "userId": "${users[userCounter]?.id}" }`)
      if (userCounter < users.length - 1)
        userCounter++
    }
    const port = Number(process.env.PORT ?? 3000);

    async function start(): Promise<void> {
      await sequelize.authenticate();

      const server = app.listen(port, '0.0.0.0', () => {
        console.log(`Event registration API is listening on port ${port}`);
      });

      const shutdown = () => {
        server.close(() => {
          void sequelize.close().finally(() => process.exit(0));
        });
      };

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
    await start()
    const response = await autocannon({
      url: `http://localhost:${port}`,
      connections: 15,
      duration: 10,
      setupClient,
      requests: [
        {
          method: 'POST',
          path: `/events/${SEED_EVENT_IDS.main}/registrations`,
          headers: {
            'Content-type': 'application/json; charset=utf-8'
          }
        }
      ],
    })
    expect(response.errors).toBe(0);
    expect(response.timeouts).toBe(0);
    expect(response['5xx']).toBe(0);
    expect(response.statusCodeStats?.['201']?.count).toBe(
      await Registration.count({ where: { eventId: SEED_EVENT_IDS.main } })
    )
    console.log(`autocannon: ${JSON.stringify(response.statusCodeStats)}`)
    await Registration.destroy({ where: { eventId: SEED_EVENT_IDS.main } })
  })
});
