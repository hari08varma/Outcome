# Supabase Realtime Setup

The dashboard uses Supabase Realtime to stream live updates to three pages: **Alerts**, **Outcomes**, and **Trust**.

## Required: Enable Realtime on Tables

In the **Supabase Dashboard → Table Editor**, enable the Realtime toggle for each of these tables:

| Table                        | Page     | Events        |
|------------------------------|----------|---------------|
| `degradation_alert_events`   | Alerts   | INSERT        |
| `fact_outcomes`              | Outcomes | INSERT        |
| `agent_trust_scores`         | Trust    | INSERT, UPDATE|

**Steps:**
1. Go to **Table Editor** in the Supabase Dashboard
2. Select the table
3. Click the **Realtime** toggle → **ON**
4. Repeat for all three tables

Without this step, the hooks subscribe successfully but never receive events. The UI will show a grey "disconnected" indicator — it will not crash.

## How It Works

Each page uses a custom hook (`useRealtimeAlerts`, `useRealtimeOutcomes`, `useRealtimeTrust`) that:

1. Opens a Supabase Realtime channel on mount
2. Listens for `postgres_changes` events
3. Calls back into the page to update state
4. Cleans up the channel on unmount (no orphan subscriptions)

Connection status is shown via the `LiveIndicator` component (green pulsing dot = connected, grey dot = disconnected).

## RLS Notes

Realtime subscriptions only receive rows the current user has RLS access to. No additional client-side filtering is needed for security — RLS policies are enforced server-side.
