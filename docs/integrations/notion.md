# Notion KnowledgeProvider

Notion is Luma's canonical provider for Meeting records, decisions, and durable organizational knowledge. It does not own executable work.

## Setup

1. Create a Notion internal integration for the environment.
2. Grant read, insert, and update content capabilities.
3. Open the Dayova Meetings data source and connect the integration.
4. Set the token and data-source ID in `.env`.

```dotenv
NOTION_API_TOKEN=
NOTION_MEETINGS_DATA_SOURCE_ID=3982e872-28bf-8080-bf00-000b188b90d6
NOTION_MEETINGS_TITLE_PROPERTY=Name
NOTION_MEETINGS_ATTENDEES_PROPERTY=Attendees
LUMA_NOTION_PROVIDER_ID=notion
```

The configured schema expects `Name` as a title property and `Attendees` as a People property.

## Meeting Record

An approved `record-meeting` Intent writes one page containing:

- Conclusion summary and detail
- decisions and their current status
- Action Items, owner state, and due-date state
- open questions and risks
- Meeting Revision and approved Intent provenance
- an execution idempotency marker

Meeting participants resolve through the Identity Directory to Notion user IDs and populate `Attendees`. Original speech stays canonical in Luma's Evidence store; the Notion record is a concluded representation, not a replacement transcript source.

## Idempotency

The Notion API does not accept a caller idempotency key for page creation. Luma writes a visible, unobtrusive `Luma execution key` line and searches pages in the configured data source before creating another page. The durable local execution record provides the first retry barrier.

## Troubleshooting

- `object_not_found`: share the Meetings data source with the integration and verify its ID.
- Validation error for `Name`: configure the actual title-property name.
- Validation error for `Attendees`: configure a People property or remove that property only in a custom deployment.
- Missing attendee: confirm the Person has a Notion user ID and that the user is visible to the integration.

The Notion SDK is contained behind Luma's owned `NotionApi` facade and `KnowledgeProvider` Interface.

## Non-mutating Live Test

```bash
set -a
source .env
set +a
LUMA_LIVE_NOTION_TESTS=1 pnpm test -- tests/knowledge/notion-knowledge-provider.live.test.ts
```
