-- Stores the provider-shaped content blocks for an assistant turn.
--
-- The agent's history has to be replayed exactly: a tool_result block must
-- follow the tool_use block it answers, with the same id, or the next request
-- is rejected. Keeping the raw turn means a follow-up question reuses what was
-- already retrieved instead of starting the research again.
ALTER TABLE ai_messages ADD COLUMN raw_turn jsonb;

-- Conversations are listed by recency and read whole; this covers both.
CREATE INDEX ai_messages_workspace_idx ON ai_messages (workspace_id, created_at DESC);
