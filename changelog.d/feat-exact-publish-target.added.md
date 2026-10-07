- Every conversation now declares where a host's publish lands (MCPL
  RFC-011): its descriptor carries `capabilities.publish.target: 'exact'`,
  and `channels/publish` honors the RFC's `threadId` (#6). A thread's parent
  ts posts into exactly that thread, and `null` posts at the top level, even
  when a newer incoming message sits in some thread. The result echoes
  `threadId` from Slack's own response (the parent ts, or `null`). A target
  that can't be honored fails with nothing posted, as `delivered: false`
  with a `reason` and no message id: a ts that isn't a message in this
  conversation, or is a reply rather than a thread's parent (every thread
  target is checked with `conversations.replies` just before posting); an
  invalid value; a conversation `SLACK_SEND_CHANNELS` or
  `SLACK_DISABLE_DMS` blocks; or Slack's own refusal, such as a
  thread-only channel. A request without `threadId` keeps the
  latest-incoming-thread placement and result shape exactly.
