import { queryItem } from 'es-dcb-library';

const runQuery = (period) =>
  queryItem({ types: ['CollectionRunScheduled', 'CollectionRunStarted'], tags: [`collection-run:${period}`] });

// Command handler: StartCollectionRun -> CollectionRunStarted. Once per period.
export async function startCollectionRun(store, { period, now }) {
  const query = runQuery(period);
  const { events, position } = await store.load(query);
  const scheduled = events.find((e) => e.type === 'CollectionRunScheduled');

  if (!scheduled) throw new Error('CollectionRunNotScheduled');
  if (events.some((e) => e.type === 'CollectionRunStarted')) throw new Error('CollectionRunAlreadyStarted');
  if (new Date(now) < new Date(scheduled.data.dueAt)) throw new Error('CollectionRunNotDueYet');

  const [event] = await store.append(
    {
      type: 'CollectionRunStarted',
      data: { period, dueAt: scheduled.data.dueAt, startedAt: new Date(now).toISOString() },
      tags: [`collection-run:${period}`],
    },
    { failIfEventsMatch: query, after: position },
  );
  return event;
}
