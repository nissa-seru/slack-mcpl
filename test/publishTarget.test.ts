/**
 * MCPL RFC-011 targeted publish on Slack: every conversation declares
 * `capabilities.publish.target: 'exact'`, and a publish carrying `threadId`
 * lands exactly there (a thread's parent ts, or top level for null) or fails
 * with nothing posted. A publish without the field keeps the legacy
 * latest-incoming-thread placement.
 *
 * Platform boundary: every Slack call here is a stub at the web client. What
 * real Slack does with a stale or non-parent `thread_ts` on chat.postMessage
 * is not established by these tests; the server does not rely on it, because
 * every thread target — even one seen arriving — is checked with
 * conversations.replies just before posting. Only a deletion in the moment
 * between that check and the post is left to the platform.
 *
 * Run: node --import tsx --test test/publishTarget.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, harness, initialize, until, type HarnessOptions, type WebOverrides } from './harness.js';

type Post = { channel: string; text: string; thread_ts?: string };

/** A platform stub for chat.postMessage that answers like Slack: the posted
 *  message, with thread_ts when it was a reply. */
const echoingPost = async (args: Record<string, unknown>) => ({
  ts: '200.1',
  message: { ts: '200.1', ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}) },
});

async function ready(opts: HarnessOptions = {}) {
  const h = harness({ ...opts, web: { postMessage: echoingPost, ...opts.web } });
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'registration');
  return h;
}

const publish = (h: Awaited<ReturnType<typeof ready>>, extra: Record<string, unknown>) =>
  h.host.sendRequest(method.CHANNELS_PUBLISH, {
    conversationId: 'conv', channelId: 'slack:C1', content: [{ type: 'text', text: 'answer' }], ...extra,
  }) as Promise<Record<string, unknown>>;

/** A mention inside thread `parent` (a reply), as Socket Mode delivers it. */
const threadReply = (parent: string, ts: string) => ({
  type: 'message', channel: 'C1', user: 'U2', text: '<@UBOT> in the thread', ts, thread_ts: parent,
});

test('every conversation declares an exact publish target', async () => {
  const h = await ready();
  const reg = h.hostSaw.find((r) => r.method === method.CHANNELS_REGISTER)!;
  const channels = (reg.params as { channels: Array<{ id: string; capabilities?: Record<string, unknown> }> }).channels;
  assert.ok(channels.length > 0);
  for (const c of channels) assert.deepEqual(c.capabilities?.publish, { target: 'exact' }, c.id);
  await h.close();
});

test('a legacy publish (no threadId) keeps the latest-incoming-thread placement and result shape', async () => {
  const h = await ready();
  await h.socket.emitMessage(threadReply('50.1', '51.1'));
  const res = await publish(h, {});
  assert.deepEqual(Object.keys(res).sort(), ['delivered', 'messageId']);
  assert.equal((h.posts.at(-1) as Post).thread_ts, '50.1');
  await h.close();
});

test('threadId null posts at the top level even after a threaded arrival (the root race)', async () => {
  const h = await ready();
  await h.socket.emitMessage(threadReply('50.1', '51.1'));
  const res = await publish(h, { threadId: null });
  assert.equal(res.delivered, true);
  assert.ok('threadId' in res && res.threadId === null, 'echoed from the posted message: top level');
  assert.equal((h.posts.at(-1) as Post).thread_ts, undefined);
  await h.close();
});

test('a thread seen arriving is still confirmed before posting, targeted exactly, and echoed', async () => {
  const asked: unknown[] = [];
  const h = await ready({ web: { replies: async (args) => { asked.push(args); return { messages: [{ ts: '50.1', thread_ts: '50.1' }] }; } } });
  await h.socket.emitMessage(threadReply('50.1', '51.1'));
  await h.socket.emitMessage({ type: 'message', channel: 'C1', user: 'U3', text: '<@UBOT> elsewhere', ts: '61.1', thread_ts: '60.1' });
  const res = await publish(h, { threadId: '50.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '50.1');
  assert.equal((h.posts.at(-1) as Post).thread_ts, '50.1', 'its own thread, not the newer one');
  assert.deepEqual(asked, [{ channel: 'C1', ts: '50.1', limit: 1 }], 'confirmed even though it was seen arriving');
  await h.close();
});

test('a parent seen arriving and deleted since is refused, never posted with a stale thread_ts', async () => {
  const notFound = Object.assign(new Error('An API error occurred: thread_not_found'), {
    code: 'slack_webapi_platform_error', data: { ok: false, error: 'thread_not_found' },
  });
  const h = await ready({ web: { replies: async () => { throw notFound; } } });
  await h.socket.emitMessage(threadReply('50.1', '51.1'));
  const res = await publish(h, { threadId: '50.1' });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /no message 50\.1/);
  assert.equal(h.posts.length, 0);
  await h.close();
});

test('an unseen thread parent is confirmed with Slack, then posted into, every time', async () => {
  const asked: unknown[] = [];
  const h = await ready({ web: { replies: async (args) => { asked.push(args); return { messages: [{ ts: '70.1', thread_ts: '70.1' }] }; } } });
  const res = await publish(h, { threadId: '70.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '70.1');
  assert.deepEqual(asked, [{ channel: 'C1', ts: '70.1', limit: 1 }]);
  assert.equal((h.posts.at(-1) as Post).thread_ts, '70.1');
  // No cache: the next publish to it is confirmed again.
  await publish(h, { threadId: '70.1' });
  assert.equal(asked.length, 2);
  await h.close();
});

test('a top-level message with no replies yet can be replied under', async () => {
  const h = await ready({ web: { replies: async () => ({ messages: [{ ts: '80.1' }] }) } });
  const res = await publish(h, { threadId: '80.1' });
  assert.equal(res.delivered, true);
  assert.equal(res.threadId, '80.1');
  await h.close();
});

test('targets that cannot be honored fail with nothing posted', async () => {
  const notFound = Object.assign(new Error('An API error occurred: thread_not_found'), {
    code: 'slack_webapi_platform_error', data: { ok: false, error: 'thread_not_found' },
  });
  const cases: Array<{ threadId: unknown; replies?: WebOverrides['replies']; reason: RegExp }> = [
    { threadId: '90.1', replies: async () => { throw notFound; }, reason: /no message 90\.1/ },
    // A reply's ts: Slack answers with the thread's parent first.
    { threadId: '91.2', replies: async () => ({ messages: [{ ts: '91.1', thread_ts: '91.1' }] }), reason: /reply inside a thread/ },
    { threadId: '92.1', replies: async () => { throw new Error('socket hang up'); }, reason: /could not confirm thread 92\.1/ },
    { threadId: 'not-a-ts', reason: /invalid threadId/ },
    { threadId: 7, reason: /invalid threadId/ },
    { threadId: '', reason: /invalid threadId/ },
  ];
  for (const c of cases) {
    const h = await ready({ web: c.replies ? { replies: c.replies } : {} });
    const res = await publish(h, { threadId: c.threadId });
    assert.equal(res.delivered, false, JSON.stringify(c.threadId));
    assert.equal('messageId' in res, false, 'no message id: definitely not posted');
    assert.equal('threadId' in res, false, 'nothing landed, so nothing is echoed');
    assert.match(String(res.reason), c.reason);
    assert.equal(h.posts.length, 0, 'nothing reached chat.postMessage');
    await h.close();
  }
});

test("Slack's own refusal is a definite failure; an uncertain error stays an error", async () => {
  const platform = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), {
    code: 'slack_webapi_platform_error', data: { ok: false, error },
  });
  const refused = await ready({ web: { postMessage: async () => { throw platform('restricted_action_thread_only_channel'); } } });
  const res = await publish(refused, { threadId: null });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /restricted_action_thread_only_channel/);
  await refused.close();

  const uncertain = await ready({ web: { postMessage: async () => { throw platform('internal_error'); } } });
  await assert.rejects(publish(uncertain, { threadId: null }), /internal_error/);
  await uncertain.close();
});

test('a post whose response names no message carries no echo (the host cannot confirm it)', async () => {
  const h = await ready({ web: { postMessage: async () => ({ ts: '300.1' }) } });
  const res = await publish(h, { threadId: null });
  assert.equal(res.delivered, true);
  assert.equal('threadId' in res, false);
  await h.close();
});

test('a targeted publish this server would block is refused before Slack, not left uncertain', async () => {
  const excluded = await ready({ sendChannels: ['COTHER'] });
  const res = await publish(excluded, { threadId: null });
  assert.equal(res.delivered, false);
  assert.equal('messageId' in res, false);
  assert.match(String(res.reason), /SLACK_SEND_CHANNELS/);
  assert.equal(excluded.posts.length, 0);
  await excluded.close();

  // SLACK_DISABLE_DMS: a DM is a certain no-post too.
  const noDms = await ready({ disableDms: true });
  const dm = (await noDms.host.sendRequest(method.CHANNELS_PUBLISH, {
    conversationId: 'conv', channelId: 'slack:D1', threadId: null, content: [{ type: 'text', text: 'hi' }],
  })) as Record<string, unknown>;
  assert.equal(dm.delivered, false);
  assert.equal('messageId' in dm, false);
  assert.match(String(dm.reason), /SLACK_DISABLE_DMS/);
  assert.equal(noDms.posts.length, 0);
  await noDms.close();
});
